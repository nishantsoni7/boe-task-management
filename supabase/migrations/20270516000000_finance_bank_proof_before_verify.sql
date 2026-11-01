-- ═════════════════════════════════════════════════════════════════════════════
-- An HDFC payment is verified only against the bank
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHY. Two sides created payment records for the same money: Sales recording a
-- request, and a bank statement adding its credits. Nothing joined the two, so
-- one transfer could become two payments. From now on a request is the only thing
-- that creates a payment, and the owner verifies it against the bank credit.
--
-- THE RULE, IN ONE PLACE. A payment recorded as HDFC PRI or HDFC SEC cannot turn
-- verified unless bank credits IN ITS OWN ACCOUNT cover its full amount, or an
-- admin has said it is urgent and the bank check is pending. It is a trigger on
-- the table, not a check in a screen, because a payment can reach verified from
-- more than one place: Payment Requests, the PI page, a self-verifier's own entry,
-- and an admin's status write. One credit cannot carry more than its amount
-- (link_bank_line_to_payment refuses), so a second payment for the same money has
-- nothing to cover it and cannot be confirmed. Unlinking the first payment frees the
-- credit, on purpose: that is how a wrong link is put right, and the payment left
-- without a credit then stands on Payments not in the bank.
--
-- AN EDIT IS HELD TO THE SAME RULE. finance.manage may change the amount and the
-- account of a verified payment, so the trigger also watches those: an edit may not
-- leave a payment short of the bank when it was not short before. A payment already
-- short, verified before this rule, can still be corrected.
--
-- WHAT THIS ADDS
--
--   finance_payment_bank_exceptions   one row per payment an admin verified before
--                                     its bank credit could be seen, with the
--                                     reason. Bank check pending is DERIVED from
--                                     this row and the links, so nothing has to
--                                     clear it: link the credit and it is done. The
--                                     row goes if the payment stops being verified,
--                                     so it can never excuse a second verification.
--
--   verify_payment_with_bank(id, lines)
--                                     links the named credits and verifies, in one
--                                     transaction. Needs finance.reconcile and
--                                     finance.approve. Refused, and nothing is
--                                     linked, if the credits do not cover the payment.
--
--   verify_payment_bank_check_pending(id, reason)
--                                     an active admin only: records the reason and
--                                     verifies through the same door.
--
--   finance_bank_check_pending()      the list of those payments still short.
--
--   complete_payment_entry            an HDFC entry by somebody who may verify their
--                                     own payments now stays pending until it is
--                                     matched, instead of failing the whole entry.
--
-- WHAT THIS DOES NOT CHANGE
--   Payments already verified. PNB, Paytm and Canara. Payments marked as test data.
--   approve_finance_payment_request itself. sync_bank_credits and
--   add_bank_line_to_confirmed still work: the screens stop calling them, and
--   they are closed to browsers by a later migration, once the new screens are live.
--
-- ROLLBACK:
--   drop trigger finance_payment_requests_require_bank_proof on public.finance_payment_requests;
--   drop function public.finance_payment_requests_require_bank_proof();
--   drop function public.finance_bank_check_pending();
--   drop function public.verify_payment_bank_check_pending(uuid, text);
--   drop function public.verify_payment_with_bank(uuid, uuid[]);
--   drop function public.finance_payment_awaits_bank_match(uuid, text, numeric, boolean);
--   drop table public.finance_payment_bank_exceptions;
--   then re-run the complete_payment_entry section of 20270120000000 with its grants.
-- Payments verified meanwhile stay verified, and their links stay.
-- ═════════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.approve_finance_payment_request(uuid, text)') is null
     or to_regprocedure('public.link_bank_line_to_payment(uuid, uuid, numeric)') is null
     or to_regprocedure('public.assert_bank_reconcile_door()') is null
     or to_regprocedure('public.complete_payment_entry(uuid)') is null then
    raise exception 'this migration needs the payment and bank doors to exist first';
  end if;
end
$$;


-- ═══ §1. The record of an urgent verification ═══════════════════════════════

create table if not exists public.finance_payment_bank_exceptions (
  payment_id uuid        primary key references public.finance_payment_requests(id) on delete cascade,
  reason     text        not null check (length(btrim(reason)) between 3 and 200),
  created_by uuid        not null references public.users(id),
  created_at timestamptz not null default now()
);

comment on table public.finance_payment_bank_exceptions is
  'One row per HDFC payment an active admin verified before its bank credit could be seen. Never updated. Read through finance_bank_check_pending; no client role reaches the table. 20270516000000.';

alter table public.finance_payment_bank_exceptions enable row level security;
revoke all on public.finance_payment_bank_exceptions from public, anon, authenticated;


-- ═══ §2. The rule ═══════════════════════════════════════════════════════════

-- True when this payment needs a bank match it does not have. Only credits in the
-- payment's own account count: a credit in the other HDFC account is another
-- account's money until a person corrects the payment.
create or replace function public.finance_payment_awaits_bank_match(
  p_payment_id uuid,
  p_mode       text,
  p_amount     numeric,
  p_is_test    boolean
) returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p_mode in ('hdfc', 'hdfc_sec')
     and not coalesce(p_is_test, false)
     and not exists (select 1 from public.finance_payment_bank_exceptions e where e.payment_id = p_payment_id)
     and coalesce((
           select sum(k.amount)
             from public.bank_line_payment_links k
             join public.bank_statement_lines l on l.id = k.line_id
            where k.payment_id = p_payment_id
              and k.unlinked_at is null
              and l.account = p_mode
         ), 0) < p_amount
$fn$;

comment on function public.finance_payment_awaits_bank_match(uuid, text, numeric, boolean) is
  'Whether an HDFC payment still lacks bank credits in its own account covering its full amount, with no recorded exception. Internal. 20270516000000.';

revoke all on function public.finance_payment_awaits_bank_match(uuid, text, numeric, boolean) from public, anon, authenticated;

create or replace function public.finance_payment_requests_require_bank_proof()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_was_verified boolean := public.finance_payment_status_is_verified(old.status);
  v_is_verified  boolean := public.finance_payment_status_is_verified(new.status);
begin
  -- An exception answers one verification. It ends when that verification does.
  if v_was_verified and not v_is_verified then
    delete from public.finance_payment_bank_exceptions where payment_id = new.id;
    return new;
  end if;

  if not v_is_verified then
    return new;
  end if;

  if not v_was_verified then
    if public.finance_payment_awaits_bank_match(new.id, new.payment_mode, new.amount, new.is_test_data) then
      raise exception 'PAYMENT_NEEDS_BANK_MATCH: payment % is not covered by a bank credit yet', old.request_number
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- Already verified: an edit may not leave it short of the bank when it was not
  -- short before. One verified before this rule, and short already, stays correctable.
  if (new.payment_mode is distinct from old.payment_mode or new.amount is distinct from old.amount)
     and public.finance_payment_awaits_bank_match(new.id, new.payment_mode, new.amount, new.is_test_data)
     and not public.finance_payment_awaits_bank_match(old.id, old.payment_mode, old.amount, old.is_test_data) then
    raise exception 'PAYMENT_EDIT_NEEDS_BANK_MATCH: this change would leave payment % without a bank credit covering it', old.request_number
      using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

comment on function public.finance_payment_requests_require_bank_proof() is
  'Refuses turning an HDFC payment verified without bank proof, or editing a verified one short of it, from any door and for any actor. Removes an exception when its payment stops being verified. 20270516000000.';

revoke all on function public.finance_payment_requests_require_bank_proof() from public, anon, authenticated;

drop trigger if exists finance_payment_requests_require_bank_proof on public.finance_payment_requests;
create trigger finance_payment_requests_require_bank_proof
  before update of status, amount, payment_mode on public.finance_payment_requests
  for each row
  when (new.status is distinct from old.status
        or new.amount is distinct from old.amount
        or new.payment_mode is distinct from old.payment_mode)
  execute function public.finance_payment_requests_require_bank_proof();


-- ═══ §3. A self-verifier's own entry waits like everybody else's ════════════

-- 20270120000000, plus the one early return below. Without it the rule above would
-- refuse inside approve_finance_payment_request and take the whole entry with it.
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

comment on function public.complete_payment_entry(uuid) is
  'The last call of a Record Payment action. For a caller holding finance.verify_own_payment (or an admin), on their own pending payment, verifies it through approve_finance_payment_request and notifies the other holders for information, unless it is an HDFC payment still waiting for its bank credit; otherwise changes nothing and returns the status. 20270516000000.';


-- ═══ §4. Verifying against the bank ═════════════════════════════════════════

-- Lines first, then the payment: the order link_bank_line_to_payment locks them in,
-- so two people working on one credit wait for each other instead of deadlocking.
create or replace function public.verify_payment_with_bank(
  p_payment_id uuid,
  p_line_ids   uuid[] default '{}'
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_lines uuid[] := coalesce(p_line_ids, '{}');
  v_pay   public.finance_payment_requests%rowtype;
  v_line  record;
  v_link  uuid;
  v_room  numeric;
begin
  perform public.assert_bank_reconcile_door();

  if cardinality(v_lines) > 20 then
    raise exception 'BANK_LINES_TOO_MANY: at most 20 credits for one payment' using errcode = '22023';
  end if;

  perform 1 from public.bank_statement_lines where id = any (v_lines) order by id for update;

  select * into v_pay from public.finance_payment_requests where id = p_payment_id for update;
  if not found or v_pay.deleted_at is not null then
    raise exception 'BANK_PAYMENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_pay.payment_mode not in ('hdfc', 'hdfc_sec') then
    raise exception 'BANK_PAYMENT_NOT_IN_A_BANK_ACCOUNT: only an HDFC payment is verified against the bank' using errcode = '22023';
  end if;

  for v_line in
    select l.id, l.account, l.deposit
      from public.bank_statement_lines l
     where l.id = any (v_lines)
     order by l.line_date, l.seq, l.id
  loop
    if v_line.account <> v_pay.payment_mode then
      raise exception 'BANK_ACCOUNT_DIFFERS: this credit is in the other HDFC account. Correct the payment first.' using errcode = '22023';
    end if;
    select k.id into v_link from public.bank_line_payment_links k
     where k.line_id = v_line.id and k.payment_id = p_payment_id and k.unlinked_at is null;
    if not found then
      perform public.link_bank_line_to_payment(v_line.id, p_payment_id, null);
    else
      -- Already linked, and the payment has grown since: one line and one payment
      -- hold one link, so that link grows, up to what the credit has left.
      v_room := least(
        v_line.deposit - (select coalesce(sum(k.amount), 0) from public.bank_line_payment_links k
                           where k.line_id = v_line.id and k.unlinked_at is null),
        v_pay.amount - (select coalesce(sum(k.amount), 0) from public.bank_line_payment_links k
                         where k.payment_id = p_payment_id and k.unlinked_at is null));
      if v_room > 0 then
        update public.bank_line_payment_links set amount = amount + v_room where id = v_link;
      end if;
    end if;
  end loop;

  -- The rule itself refuses too, but this says so before any status is touched,
  -- and the links above go back with it.
  if public.finance_payment_awaits_bank_match(p_payment_id, v_pay.payment_mode, v_pay.amount, v_pay.is_test_data) then
    raise exception 'PAYMENT_NEEDS_BANK_MATCH: payment % is not covered by a bank credit yet', v_pay.request_number
      using errcode = 'P0001';
  end if;

  return public.approve_finance_payment_request(p_payment_id, null);
end;
$fn$;

comment on function public.verify_payment_with_bank(uuid, uuid[]) is
  'Links the named bank credits to an HDFC payment and verifies it, in one transaction. Needs finance.reconcile here and finance.approve in the verification door. 20270516000000.';

revoke all on function public.verify_payment_with_bank(uuid, uuid[]) from public, anon;
grant execute on function public.verify_payment_with_bank(uuid, uuid[]) to authenticated;

create or replace function public.verify_payment_bank_check_pending(
  p_payment_id uuid,
  p_reason     text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor  uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_pay    public.finance_payment_requests%rowtype;
begin
  if v_actor is null
     or not public.module_entry_open('finance')
     or not exists (select 1 from public.users u
                     where u.id = v_actor and u.role = 'admin' and u.is_active
                       and coalesce(u.is_deleted, false) = false) then
    raise exception 'BANK_CHECK_PENDING_ADMIN_ONLY: only an admin may verify before the bank credit is seen' using errcode = '42501';
  end if;

  if length(v_reason) < 3 then
    raise exception 'BANK_REASON_REQUIRED: say why this cannot wait' using errcode = '22023';
  end if;
  if length(v_reason) > 200 then
    raise exception 'BANK_REASON_TOO_LONG: keep the reason under 200 characters' using errcode = '22023';
  end if;

  select * into v_pay from public.finance_payment_requests where id = p_payment_id for update;
  if not found or v_pay.deleted_at is not null then
    raise exception 'BANK_PAYMENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_pay.payment_mode not in ('hdfc', 'hdfc_sec') then
    raise exception 'BANK_PAYMENT_NOT_IN_A_BANK_ACCOUNT: only an HDFC payment waits for the bank' using errcode = '22023';
  end if;

  insert into public.finance_payment_bank_exceptions (payment_id, reason, created_by)
  values (p_payment_id, v_reason, v_actor)
  on conflict (payment_id) do nothing;

  -- Anything it refuses takes the row above back with it.
  return public.approve_finance_payment_request(p_payment_id, null);
end;
$fn$;

comment on function public.verify_payment_bank_check_pending(uuid, text) is
  'An active admin verifies an HDFC payment before its bank credit can be seen, with a reason. It counts at once and stays on finance_bank_check_pending until bank credits cover it. 20270516000000.';

revoke all on function public.verify_payment_bank_check_pending(uuid, text) from public, anon;
grant execute on function public.verify_payment_bank_check_pending(uuid, text) to authenticated;


-- ═══ §5. What is still waiting for its bank credit ══════════════════════════

create or replace function public.finance_bank_check_pending()
returns table (
  payment_id uuid, human_payment_id text, client_name text, amount numeric, covered numeric,
  payment_date date, payment_mode text, proof_note text, status text,
  reason text, created_at timestamptz, created_by_name text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  perform public.assert_bank_reconcile_door();
  return query
    select p.id, p.human_payment_id, p.client_name, p.amount,
           coalesce(c.total, 0), p.payment_date, p.payment_mode, p.proof_note, p.status,
           e.reason, e.created_at, u.full_name
      from public.finance_payment_bank_exceptions e
      join public.finance_payment_requests p on p.id = e.payment_id
      left join public.users u on u.id = e.created_by
      left join lateral (
        select sum(k.amount) as total
          from public.bank_line_payment_links k
          join public.bank_statement_lines l on l.id = k.line_id
         where k.payment_id = p.id and k.unlinked_at is null and l.account = p.payment_mode
      ) c on true
     where p.deleted_at is null
       and public.finance_payment_status_is_verified(p.status)
       and coalesce(c.total, 0) < p.amount
     order by p.payment_date, p.human_payment_id;
end;
$fn$;

comment on function public.finance_bank_check_pending() is
  'Payments an admin verified before their bank credit could be seen, while credits in their own account do not cover them yet. Needs finance.reconcile. 20270516000000.';

revoke all on function public.finance_bank_check_pending() from public, anon;
grant execute on function public.finance_bank_check_pending() to authenticated;


-- ═══ §6. Asserted, not assumed ══════════════════════════════════════════════

do $assert$
declare
  f text;
begin
  foreach f in array array[
    'public.finance_payment_awaits_bank_match(uuid, text, numeric, boolean)',
    'public.finance_payment_requests_require_bank_proof()'
  ] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% must not be callable from a browser', f;
    end if;
  end loop;

  foreach f in array array[
    'public.verify_payment_with_bank(uuid, uuid[])',
    'public.verify_payment_bank_check_pending(uuid, text)',
    'public.finance_bank_check_pending()'
  ] loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception '% must not be executable by anon', f;
    end if;
    if not has_function_privilege('authenticated', f, 'execute') then
      raise exception '% must be executable by authenticated', f;
    end if;
  end loop;

  if has_table_privilege('authenticated', 'public.finance_payment_bank_exceptions', 'select') then
    raise exception 'finance_payment_bank_exceptions must not be readable by a client role';
  end if;

  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.finance_payment_requests'::regclass
                    and tgname = 'finance_payment_requests_require_bank_proof'
                    and not tgisinternal) then
    raise exception 'the bank proof trigger is missing';
  end if;
end
$assert$;
