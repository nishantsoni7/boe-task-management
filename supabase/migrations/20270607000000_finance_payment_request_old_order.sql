-- ═════════════════════════════════════════════════════════════════════
-- 20270607000000 — A Payment Request can be for an OLD ORDER
-- ═════════════════════════════════════════════════════════════════════
--
-- THE GAP. 20270407000000 let Finance attach a payment to an OLD order that is
-- not in this system (its number and client, typed) in Allocate Funds and in
-- Record Payment. The Payment Request form, where Sales send money for
-- approval, still offered only PI Draft, Confirmed Order and Suspense Entry, so
-- a payment for an old order had to be sent as Suspense and allocated by hand.
-- Many old orders will take months to close; each of their payments should say
-- what it is for when it is sent.
--
-- THE CHANGE. A fourth destination, 'old_order'. A request for one is still
-- UNVERIFIED money, so, like every other destination, it writes an INTENT, not
-- an allocation: finance_payment_allocation_intents gains the two typed facts
-- (legacy_order_no, legacy_client_name) and a third kind, 'legacy_order'. No
-- total, balance, classification or gate reads an intent. When Finance approves,
-- apply_payment_allocation_intents converts it through
-- allocate_payment_to_legacy_order_internal — the one implementation of "an old
-- order", 20270407000000 §4 — so an old-order request becomes exactly the
-- allocation Allocate Funds would have made: it spends part of the payment and
-- never reaches an Order total, a PI total or the 40% gate.
--
-- WHAT IS WRAPPED, NOT REWRITTEN. Two deployed bodies are left byte-for-byte
-- where they are and used as they are:
--   * submit_payment_request_core (20261014000000) writes the payment, its
--     custody trail and the idempotency record. The new door sends it the
--     request as a Suspense Entry (no target, no customer, no intent) and then
--     places the old-order intent and the typed customer in the same
--     transaction.
--   * edit_payment_request (20270322000000) is renamed edit_payment_request_base
--     and closed to clients. The new door passes every other destination
--     straight through; for an old order it corrects the request as a Suspense
--     Entry (the base cancels the old intent, rewrites the row, re-checks every
--     rule) and then places the old-order intent. A request that already carries
--     an ALLOCATION (a PI-page payment) is still refused by the base: its
--     destination is locked, so it cannot be moved to an old order here.
-- Only apply_payment_allocation_intents (20261013000000 §4) is restated: the
-- same body with ONE branch that sends a legacy intent to the legacy allocator.
--
-- WHAT IS NOT TOUCHED: finance_payment_destinations (20261014000000 §8, patched
-- by 20270221000000; the application names an old-order payment itself), the
-- allocations table, every Order / PI total, every permission. Approval is
-- still finance.approve; the allocator re-checks everything at approval.
--
-- COMPATIBILITY. Both doors gain two TRAILING parameters with defaults, so every
-- existing caller (the Payment Request and Edit forms, create_payment_from_bank_
-- line, sync_bank_credits — all by named arguments) works unchanged. The old
-- signatures are DROPPED / renamed: two overloads that both accept the same
-- named call are ambiguous to PostgreSQL. The idempotency fingerprint of every
-- non-old-order submission is unchanged, so a key already in flight when this
-- applies still replays.
--
-- ROLLBACK: nothing is lost by leaving the columns. Cancel any pending
-- old-order request first (reject it), then re-emit the previous bodies:
-- submit_payment_request (20261219000000), edit_payment_request
-- (20270322000000, un-rename the base) and apply_payment_allocation_intents
-- (20261013000000 §4).
-- ═════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.submit_payment_request(text, uuid, numeric, date, text, text, text, jsonb, uuid)') is null
     or to_regprocedure('public.submit_payment_request_core(text, uuid, numeric, date, text, text, text, jsonb)') is null
     or to_regprocedure('public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, jsonb)') is null
     or to_regprocedure('public.apply_payment_allocation_intents(uuid)') is null
     or to_regprocedure('public.allocate_payment_to_legacy_order_internal(uuid, text, text, numeric)') is null
     or to_regprocedure('public.normalize_legacy_order_no(text)') is null then
    raise exception 'DEPENDENCY MISSING: 20261013000000, 20261219000000, 20270322000000 and 20270407000000 must be applied first';
  end if;

  if to_regprocedure('public.edit_payment_request_base(uuid, text, uuid, numeric, date, text, text, text, jsonb)') is not null then
    raise exception 'ALREADY APPLIED: edit_payment_request_base exists';
  end if;
end $$;

-- ═════════════════════════════════════════════════════════════════════
-- §1. The intent can name an old order
-- ═════════════════════════════════════════════════════════════════════
--
-- The same two columns, with the same shape rules, as the allocation it becomes
-- (finance_payment_allocations_legacy_shape, 20270407000000 §1), so the
-- conversion is still a row-for-row mapping.

alter table public.finance_payment_allocation_intents
  add column if not exists legacy_order_no    text,
  add column if not exists legacy_client_name text;

comment on column public.finance_payment_allocation_intents.legacy_order_no is
  'The OLD order number a pending request intends its money for, normalised like finance_payment_allocations.legacy_order_no. Set only on a legacy_order intent. 20270607000000.';
comment on column public.finance_payment_allocation_intents.legacy_client_name is
  'The client the old order belongs to, as typed on the request. Set together with legacy_order_no and never otherwise. 20270607000000.';

alter table public.finance_payment_allocation_intents
  drop constraint if exists finance_payment_allocation_intents_target_type_check;
alter table public.finance_payment_allocation_intents
  add constraint finance_payment_allocation_intents_target_type_check
  check (target_type in ('pi_draft', 'confirmed_order', 'legacy_order'));

-- An intent names EXACTLY ONE target, of its own kind. The two record kinds are
-- as they were, now also carrying no old-order facts; the third names neither a
-- PI Draft nor an Order and carries both typed facts, trimmed and bounded.
alter table public.finance_payment_allocation_intents
  drop constraint if exists finance_payment_allocation_intents_one_target;
alter table public.finance_payment_allocation_intents
  add constraint finance_payment_allocation_intents_one_target check (
    (target_type = 'pi_draft'
       and order_submission_id is not null and order_id is null
       and legacy_order_no is null and legacy_client_name is null)
    or
    (target_type = 'confirmed_order'
       and order_id is not null and order_submission_id is null
       and legacy_order_no is null and legacy_client_name is null)
    or
    (target_type = 'legacy_order'
       and order_submission_id is null and order_id is null
       and legacy_order_no is not null
       and legacy_order_no = public.normalize_legacy_order_no(legacy_order_no)
       and length(legacy_order_no) <= 60
       and legacy_client_name is not null
       and btrim(legacy_client_name) <> ''
       and legacy_client_name = btrim(legacy_client_name)
       and length(legacy_client_name) <= 120)
  );

-- One PENDING claim per payment per old order, like the two indexes beside it.
create unique index if not exists finance_payment_allocation_intents_pending_legacy_idx
  on public.finance_payment_allocation_intents (payment_request_id, legacy_order_no)
  where status = 'pending' and legacy_order_no is not null;

-- ═════════════════════════════════════════════════════════════════════
-- §2. place_old_order_intent_internal — the one place an old-order intent is written
-- ═════════════════════════════════════════════════════════════════════
--
-- Called by the two doors below, after their own authorization and after the
-- payment row exists, and by nothing else; executable by no client role.
--
-- It does three things, in one transaction with the caller:
--   1. refuses a missing or oversized old order number / client, by name;
--   2. stores the typed client on the payment as its customer. A request for a
--      PI Draft or an Order takes its customer from that record; for an old
--      order there is no record, so the typed name is the customer;
--   3. writes the intent. If this very transaction has just cancelled an intent
--      for the SAME old order (an edit that only changed the amount, date or
--      client), that row is brought back rather than leaving a cancelled copy
--      behind, so a correction leaves one row. The capacity trigger re-runs
--      against the payment's current amount either way.

create or replace function public.place_old_order_intent_internal(
  p_payment_request_id uuid,
  p_legacy_order_no    text,
  p_legacy_client_name text,
  p_amount             numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := auth.uid();
  v_no     text := public.normalize_legacy_order_no(p_legacy_order_no);
  v_client text := nullif(btrim(regexp_replace(coalesce(p_legacy_client_name, ''), '\s+', ' ', 'g')), '');
  v_prev   uuid;
  v_intent uuid;
begin
  if v_actor is null then
    raise exception 'Authentication required to submit a payment request'
      using errcode = '28000';
  end if;

  if v_no is null then
    raise exception 'PAYMENT_LEGACY_ORDER_REQUIRED: enter the old order number.'
      using errcode = 'P0001';
  end if;
  if length(v_no) > 60 then
    raise exception 'PAYMENT_LEGACY_ORDER_TOO_LONG: an old order number can be at most 60 characters.'
      using errcode = 'P0001';
  end if;
  if v_client is null then
    raise exception 'PAYMENT_LEGACY_CLIENT_REQUIRED: enter the client the old order belongs to.'
      using errcode = 'P0001';
  end if;
  if length(v_client) > 120 then
    raise exception 'PAYMENT_LEGACY_CLIENT_TOO_LONG: a client name can be at most 120 characters.'
      using errcode = 'P0001';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'PAYMENT_AMOUNT_INVALID: enter a positive amount in rupees and paise.'
      using errcode = 'P0001';
  end if;

  update public.finance_payment_requests
     set client_name = v_client
   where id = p_payment_request_id;
  if not found then
    raise exception 'PAYMENT_NOT_FOUND: that payment request no longer exists.'
      using errcode = 'P0002';
  end if;

  -- Only an intent the edit base cancelled a moment ago, in THIS transaction
  -- (now() is the transaction's start), for the same old order.
  select i.id into v_prev
  from public.finance_payment_allocation_intents i
  where i.payment_request_id = p_payment_request_id
    and i.status = 'cancelled'
    and i.cancelled_reason = 'destination_changed'
    and i.cancelled_at = now()
    and i.legacy_order_no = v_no
  order by i.created_at desc
  limit 1;

  if v_prev is not null then
    update public.finance_payment_allocation_intents
       set status             = 'pending',
           cancelled_at       = null,
           cancelled_reason   = null,
           intended_amount    = p_amount,
           legacy_client_name = v_client
     where id = v_prev
    returning id into v_intent;
  else
    insert into public.finance_payment_allocation_intents
      (payment_request_id, target_type, legacy_order_no, legacy_client_name,
       intended_amount, created_by)
    values
      (p_payment_request_id, 'legacy_order', v_no, v_client, p_amount, v_actor)
    returning id into v_intent;
  end if;

  return jsonb_build_object(
    'intent_id',       v_intent,
    'client_name',     v_client,
    'legacy_order_no', v_no
  );
end;
$$;

revoke execute on function public.place_old_order_intent_internal(uuid, text, text, numeric)
  from public, anon, authenticated, service_role;

comment on function public.place_old_order_intent_internal(uuid, text, text, numeric) is
  'Writes the old-order intent of one pending payment request and stores the typed client as its customer. Called by submit_payment_request and edit_payment_request after their own authorization; executable by no client role. 20270607000000.';

-- ═════════════════════════════════════════════════════════════════════
-- §3. apply_payment_allocation_intents — a legacy intent becomes a legacy allocation
-- ═════════════════════════════════════════════════════════════════════
--
-- 20261013000000 §4 verbatim (same attributes, same post-condition, same
-- result shape) plus ONE branch: an intent that carries legacy_order_no is
-- converted by allocate_payment_to_legacy_order_internal instead of
-- allocate_payment_to_target_internal. The legacy allocator takes the payment's
-- lock, refuses rejected money and a second active claim on the same old
-- order, and re-derives the balance; a refusal rolls the whole approval back.

create or replace function public.apply_payment_allocation_intents(p_payment_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_intent  record;
  v_alloc   jsonb;
  v_applied jsonb := '[]'::jsonb;
  v_count   int := 0;
  v_amount  numeric;
  v_pending numeric;
  v_active  numeric;
begin
  for v_intent in
    select *
    from public.finance_payment_allocation_intents
    where payment_request_id = p_payment_request_id
      and status = 'pending'
    order by created_at, id
    for update
  loop
    if v_intent.legacy_order_no is not null then
      v_alloc := public.allocate_payment_to_legacy_order_internal(
        p_payment_request_id => p_payment_request_id,
        p_legacy_order_no    => v_intent.legacy_order_no,
        p_legacy_client_name => v_intent.legacy_client_name,
        p_allocated_amount   => v_intent.intended_amount
      );
    else
      v_alloc := public.allocate_payment_to_target_internal(
        p_payment_request_id  => p_payment_request_id,
        p_order_submission_id => v_intent.order_submission_id,
        p_order_id            => v_intent.order_id,
        p_allocated_amount    => v_intent.intended_amount
      );
    end if;

    update public.finance_payment_allocation_intents
       set status                = 'applied',
           applied_allocation_id = (v_alloc->>'allocation_id')::uuid,
           applied_at            = now()
     where id = v_intent.id;

    -- ── POST-CONDITION: this payment is not over its own amount ──
    select f.amount into v_amount
    from public.finance_payment_requests f
    where f.id = p_payment_request_id;

    select coalesce(sum(i.intended_amount), 0) into v_pending
    from public.finance_payment_allocation_intents i
    where i.payment_request_id = p_payment_request_id
      and i.status = 'pending';

    select coalesce(sum(a.allocated_amount), 0) into v_active
    from public.finance_payment_allocations a
    where a.payment_request_id = p_payment_request_id
      and a.status = 'active';

    if v_pending + v_active > v_amount then
      raise exception
        'INTENT_CONVERSION_DOUBLE_COUNTED: after converting intent %, this payment holds % pending and % allocated against an amount of %',
        v_intent.id, v_pending, v_active, v_amount
        using errcode = 'P0001';
    end if;

    v_count  := v_count + 1;
    v_applied := v_applied || jsonb_build_array(jsonb_build_object(
      'intent_id',     v_intent.id,
      'target_type',   v_intent.target_type,
      'allocation_id', v_alloc->>'allocation_id',
      'amount',        v_intent.intended_amount
    ));
  end loop;

  return jsonb_build_object('applied_count', v_count, 'applied', v_applied);
end $$;

comment on function public.apply_payment_allocation_intents(uuid) is
  'Converts every PENDING allocation intent of one payment into an active allocation: a PI Draft or Order intent through allocate_payment_to_target_internal, an old-order intent through allocate_payment_to_legacy_order_internal, so the target is re-validated and the balance re-checked by the canonical allocator. Idempotent: only pending rows convert. Called only by approve_finance_payment_request; executable by no client role. 20261013000000, 20270607000000.';

revoke execute on function public.apply_payment_allocation_intents(uuid)
  from public, anon, authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════
-- §4. submit_payment_request — the Payment Request form's door, with 'old_order'
-- ═════════════════════════════════════════════════════════════════════
--
-- 20261219000000's door with two trailing parameters. For any other destination
-- it does what it did, byte for byte, including the idempotency fingerprint. For
-- 'old_order' the core receives a Suspense Entry (it names no target and writes
-- no intent), then place_old_order_intent_internal adds the old-order intent and
-- the customer, and the result says so. A retried keyed submission replays the
-- stored result, old-order facts included.

drop function public.submit_payment_request(text, uuid, numeric, date, text, text, text, jsonb, uuid);

create function public.submit_payment_request(
  p_destination        text,
  p_target_id          uuid    default null,
  p_amount             numeric default null,
  p_payment_date       date    default null,
  p_payment_mode       text    default null,
  p_proof_note         text    default null,
  p_sales_note         text    default null,
  p_custody_events     jsonb   default '[]'::jsonb,
  p_idempotency_key    uuid    default null,
  -- Used only by destination 'old_order'; refused for every other destination.
  p_legacy_order_no    text    default null,
  p_legacy_client_name text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old    boolean := btrim(lower(coalesce(p_destination, ''))) = 'old_order';
  v_fp     text;
  v_result jsonb;
begin
  -- AUTHORIZATION FIRST, ON EVERY CALL, KEYED OR NOT. Nothing else runs, and no
  -- key is looked up, until the caller has passed the door's questions.
  perform public.assert_finance_payment_door('submit_payment_request');

  if p_amount is not null and not public.payment_amount_is_rupees_and_paise(p_amount) then
    raise exception 'PAYMENT_AMOUNT_INVALID: enter a positive amount in rupees and paise, with no more than two decimal places.'
      using errcode = 'P0001';
  end if;

  if v_old then
    if p_target_id is not null then
      raise exception 'PAYMENT_TARGET_FORBIDDEN: an Old Order names no PI Draft and no Order.'
        using errcode = 'P0001';
    end if;
  elsif p_legacy_order_no is not null or p_legacy_client_name is not null then
    raise exception 'PAYMENT_LEGACY_FORBIDDEN: an old order number and client belong only to an Old Order request.'
      using errcode = 'P0001';
  end if;

  if p_idempotency_key is not null then
    v_fp := md5((jsonb_build_array(
      'submit_payment_request',
      nullif(btrim(p_destination), ''), p_target_id, trim_scale(p_amount)::text, p_payment_date,
      nullif(btrim(p_payment_mode), ''), nullif(btrim(p_proof_note), ''), nullif(btrim(p_sales_note), ''),
      coalesce(p_custody_events, '[]'::jsonb)
    ) || case when v_old
              then jsonb_build_array(public.normalize_legacy_order_no(p_legacy_order_no),
                                     nullif(btrim(regexp_replace(coalesce(p_legacy_client_name, ''), '\s+', ' ', 'g')), ''))
              else '[]'::jsonb end)::text);

    v_result := public.finance_payment_submission_key_claim('submit_payment_request', p_idempotency_key, v_fp);
    if v_result is not null then
      return v_result;
    end if;
  end if;

  v_result := public.submit_payment_request_core(
    case when v_old then 'suspense' else p_destination end,
    p_target_id, p_amount, p_payment_date,
    p_payment_mode, p_proof_note, p_sales_note, p_custody_events);

  if v_old then
    v_result := v_result
      || public.place_old_order_intent_internal(
           (v_result->>'payment_request_id')::uuid, p_legacy_order_no, p_legacy_client_name, p_amount)
      || jsonb_build_object('destination', 'old_order');
  end if;

  if p_idempotency_key is not null then
    perform public.finance_payment_submission_key_record('submit_payment_request', p_idempotency_key, v_fp, v_result);
  end if;
  return v_result;
end;
$$;

revoke execute on function public.submit_payment_request(text, uuid, numeric, date, text, text, text, jsonb, uuid, text, text)
  from public, anon;
grant  execute on function public.submit_payment_request(text, uuid, numeric, date, text, text, text, jsonb, uuid, text, text)
  to authenticated;

comment on function public.submit_payment_request(text, uuid, numeric, date, text, text, text, jsonb, uuid, text, text) is
  'The Payment Request form''s door. submit_payment_request_core (the 20261014000000 body) does the work; this adds the paise rule, the idempotency key and, for destination old_order, an intent naming an OLD order (number + client, typed) that Finance''s approval turns into an old-order allocation. 20261219000000, 20270607000000.';

-- ═════════════════════════════════════════════════════════════════════
-- §5. edit_payment_request — correcting a pending request, with 'old_order'
-- ═════════════════════════════════════════════════════════════════════
--
-- The deployed body (20270322000000) becomes edit_payment_request_base, closed
-- to clients, and is not edited. The new door:
--   * any other destination: the base, unchanged. The two old-order parameters
--     must be empty.
--   * 'old_order': the base corrects the request as a Suspense Entry — its
--     permission, locking, status, amount, date and mode rules all apply, every
--     pending intent is cancelled and the customer is cleared — and then the
--     old-order intent and customer are placed in the same transaction. A
--     request that already carries an allocation is refused by the base
--     (PAYMENT_EDIT_DESTINATION_LOCKED), as it is for any move.

alter function public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, jsonb)
  rename to edit_payment_request_base;

revoke execute on function public.edit_payment_request_base(uuid, text, uuid, numeric, date, text, text, text, jsonb)
  from public, anon, authenticated;

create function public.edit_payment_request(
  p_payment_request_id uuid,
  p_destination        text,
  p_target_id          uuid    default null,
  p_amount             numeric default null,
  p_payment_date       date    default null,
  p_payment_mode       text    default null,
  p_proof_note         text    default null,
  p_sales_note         text    default null,
  p_custody_events     jsonb   default '[]'::jsonb,
  -- Used only by destination 'old_order'; refused for every other destination.
  p_legacy_order_no    text    default null,
  p_legacy_client_name text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old    boolean := btrim(lower(coalesce(p_destination, ''))) = 'old_order';
  v_result jsonb;
  v_n      int;
begin
  if not v_old then
    if p_legacy_order_no is not null or p_legacy_client_name is not null then
      raise exception 'PAYMENT_LEGACY_FORBIDDEN: an old order number and client belong only to an Old Order request.'
        using errcode = 'P0001';
    end if;
    return public.edit_payment_request_base(
      p_payment_request_id, p_destination, p_target_id, p_amount, p_payment_date,
      p_payment_mode, p_proof_note, p_sales_note, p_custody_events);
  end if;

  if p_target_id is not null then
    raise exception 'PAYMENT_TARGET_FORBIDDEN: an Old Order names no PI Draft and no Order.'
      using errcode = 'P0001';
  end if;

  -- The base authorizes (the submitter or an admin), locks the payment, applies
  -- every rule, and cancels whatever the request intended before.
  v_result := public.edit_payment_request_base(
    p_payment_request_id, 'suspense', null, p_amount, p_payment_date,
    p_payment_mode, p_proof_note, p_sales_note, p_custody_events);

  v_result := v_result
    || public.place_old_order_intent_internal(
         p_payment_request_id, p_legacy_order_no, p_legacy_client_name, p_amount)
    || jsonb_build_object('destination', 'old_order');

  select count(*) into v_n
  from public.finance_payment_allocation_intents
  where payment_request_id = p_payment_request_id and status = 'pending';
  if v_n <> 1 then
    raise exception 'PAYMENT_EDIT_DUPLICATE_INTENT: this correction left % pending intents on one request', v_n
      using errcode = 'P0001';
  end if;

  return v_result;
end;
$$;

revoke execute on function public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, jsonb, text, text)
  from public, anon;
grant  execute on function public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, jsonb, text, text)
  to authenticated;

comment on function public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, jsonb, text, text) is
  'Corrects a request that is not yet verified. edit_payment_request_base (the 20270322000000 body) does the work; for destination old_order the request is corrected as a Suspense Entry and the old-order intent and customer are then placed in the same transaction. 20270322000000, 20270607000000.';

-- ═════════════════════════════════════════════════════════════════════
-- §6. Apply-time assertions
-- ═════════════════════════════════════════════════════════════════════

do $$
declare
  v_def text;
begin
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  where c.conrelid = 'public.finance_payment_allocation_intents'::regclass
    and c.conname = 'finance_payment_allocation_intents_one_target';
  if v_def is null or position('legacy_order_no' in v_def) = 0 then
    raise exception 'ASSERT: the intent one-target rule must count legacy_order_no';
  end if;

  if to_regclass('public.finance_payment_allocation_intents_pending_legacy_idx') is null then
    raise exception 'ASSERT: the one-pending-claim-per-old-order index is missing';
  end if;

  -- The old signatures are gone (two overloads would make a named call ambiguous).
  if to_regprocedure('public.submit_payment_request(text, uuid, numeric, date, text, text, text, jsonb, uuid)') is not null
     or to_regprocedure('public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, jsonb)') is not null then
    raise exception 'ASSERT: a superseded door signature is still callable';
  end if;

  -- The implementations are closed to clients; the doors are open to signed-in
  -- users and to nobody else.
  if has_function_privilege('authenticated', 'public.place_old_order_intent_internal(uuid, text, text, numeric)', 'EXECUTE')
     or has_function_privilege('anon', 'public.place_old_order_intent_internal(uuid, text, text, numeric)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.edit_payment_request_base(uuid, text, uuid, numeric, date, text, text, text, jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.edit_payment_request_base(uuid, text, uuid, numeric, date, text, text, text, jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.apply_payment_allocation_intents(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.submit_payment_request_core(text, uuid, numeric, date, text, text, text, jsonb)', 'EXECUTE') then
    raise exception 'ASSERT: an internal payment function is open to a client role';
  end if;

  if not has_function_privilege('authenticated', 'public.submit_payment_request(text, uuid, numeric, date, text, text, text, jsonb, uuid, text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.submit_payment_request(text, uuid, numeric, date, text, text, text, jsonb, uuid, text, text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, jsonb, text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, jsonb, text, text)', 'EXECUTE') then
    raise exception 'ASSERT: a payment door lost or gained a privilege';
  end if;

  if position('allocate_payment_to_legacy_order_internal' in pg_get_functiondef(
       'public.apply_payment_allocation_intents(uuid)'::regprocedure)) = 0 then
    raise exception 'ASSERT: approval must convert an old-order intent through the legacy allocator';
  end if;
end $$;
