-- ═════════════════════════════════════════════════════════════════════════════
-- Bank Statements: "Add to Confirmed Payments" from a bank credit
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A recurring credit that nobody recorded can be turned into a payment from the
-- bank line itself, in ONE transaction:
--
--   1. the payment is recorded as a Suspense entry (no customer, no target) in
--      the account the credit arrived in, dated the bank date, for the bank
--      amount, carrying the bank reference — through the SAME door every
--      payment uses (submit_payment_request), so every payment rule applies;
--   2. it is linked to the bank line (the usual link row);
--   3. complete_payment_entry verifies it on the spot ONLY for a caller who
--      holds verify_own_payment (or is an admin). Anyone else leaves it
--      "Awaiting verification", already linked, for a verifier to decide.
--
-- WHO: finance.reconcile (the Bank Statements door) AND finance.create.
--
-- DUPLICATES, refused HERE in the database (the page only explains):
--   BANK_LINE_ALREADY_LINKED   the credit already has an active link
--   BANK_LINE_CLASSIFIED       it is marked old order / not customer money
--   BANK_PAYMENT_DUPLICATE     a recorded payment (not rejected, not deleted)
--                              already carries this credit's bank reference
--   BANK_PAYMENT_POSSIBLE_DUPLICATE
--                              a recorded HDFC payment of the SAME amount,
--                              dated within 21 days, has nothing linked to a
--                              bank line yet. Refused unless the caller passes
--                              p_allow_possible_duplicate = true after seeing
--                              the message (the payment ids are in it).
-- The line row is locked first, so a double click or two people at once cannot
-- create two payments for one credit.
--
-- Nothing is allocated: the payment shows "Not identified" until somebody
-- allocates it with the existing Allocate Funds flow (finance.allocate).
--
-- ROLLBACK: drop function public.create_payment_from_bank_line(uuid, boolean);
-- Payments already created stay (they are ordinary payments).
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.create_payment_from_bank_line(
  p_line_id                  uuid,
  p_allow_possible_duplicate boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor     uuid;
  v_line      public.bank_statement_lines%rowtype;
  v_tokens    text[];
  v_ref       text;
  v_dup       record;
  v_possible  text;
  v_res       jsonb;
  v_pay_id    uuid;
  v_done      jsonb;
  v_human     text;
  v_status    text;
begin
  v_actor := public.assert_bank_reconcile_door();

  if not public.actor_has_module_permission('finance', 'create') then
    raise exception 'BANK_CREATE_FORBIDDEN: finance.create is required to add a payment' using errcode = '42501';
  end if;

  select * into v_line from public.bank_statement_lines where id = p_line_id for update;
  if not found then raise exception 'BANK_LINE_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_line.deposit <= 0 then
    raise exception 'BANK_LINE_NOT_A_CREDIT: only money in can be added as a payment' using errcode = '22023';
  end if;
  if v_line.classification is not null then
    raise exception 'BANK_LINE_CLASSIFIED: clear the old-order / not-customer-money mark first' using errcode = '22023';
  end if;
  if exists (select 1 from public.bank_line_payment_links where line_id = p_line_id and unlinked_at is null) then
    raise exception 'BANK_LINE_ALREADY_LINKED: this credit is already linked to a payment' using errcode = '22023';
  end if;

  -- The bank's own reference tokens: the statement reference and every long
  -- mixed letters-and-digits word of the narration (UTRs, NEFT/RTGS numbers).
  -- An IFSC (four letters, a zero, six characters) names a branch, not a payment.
  select coalesce(array_agg(distinct t), '{}') into v_tokens
    from (
      select upper(x) as t
        from regexp_split_to_table(upper(v_line.narration), '[^A-Z0-9]+') as x
       where length(x) >= 10 and x ~ '[0-9]' and x !~ '^[A-Z]{4}0[A-Z0-9]{6}$'
         and x !~ '^0+$'
      union
      select upper(v_line.bank_ref)
       where v_line.bank_ref is not null and length(v_line.bank_ref) >= 8 and v_line.bank_ref !~ '^0+$'
    ) s;

  if cardinality(v_tokens) > 0 then
    select p.human_payment_id, p.amount into v_dup
      from public.finance_payment_requests p
     where p.deleted_at is null
       and p.status <> 'rejected'
       and p.proof_note is not null
       and exists (
         select 1 from unnest(v_tokens) tk
          where position(tk in regexp_replace(upper(p.proof_note), '[^A-Z0-9]', '', 'g')) > 0)
     limit 1;
    if found then
      raise exception 'BANK_PAYMENT_DUPLICATE: payment % already carries this bank reference. Link it instead of adding another.',
        coalesce(v_dup.human_payment_id, '(no id)') using errcode = '22023';
    end if;
  end if;

  if not coalesce(p_allow_possible_duplicate, false) then
    select string_agg(coalesce(p.human_payment_id, p.request_number) || ' (' || coalesce(p.client_name, 'Not identified')
                      || ', ' || to_char(p.payment_date, 'DD Mon YYYY') || ')', ', ')
      into v_possible
      from public.finance_payment_requests p
     where p.deleted_at is null
       and p.status <> 'rejected'
       and p.payment_mode in ('hdfc', 'hdfc_sec')
       and p.amount = v_line.deposit
       and p.payment_date between v_line.line_date - 21 and v_line.line_date + 21
       and not exists (select 1 from public.bank_line_payment_links k
                        where k.payment_id = p.id and k.unlinked_at is null);
    if v_possible is not null then
      raise exception 'BANK_PAYMENT_POSSIBLE_DUPLICATE: this may already be recorded as %. Link that payment instead, or confirm this is a different payment.',
        v_possible using errcode = '22023';
    end if;
  end if;

  v_ref := coalesce(
    (select tk from unnest(v_tokens) tk order by length(tk) desc, tk limit 1),
    'bank statement line');

  -- The ordinary payment door: Finance entry, the paise rule, the current-mode
  -- rule, the id and request number. Suspense: no target, no customer.
  v_res := public.submit_payment_request(
    p_destination => 'suspense',
    p_target_id   => null,
    p_amount      => v_line.deposit,
    p_payment_date => v_line.line_date,
    p_payment_mode => v_line.account,
    p_proof_note  => left('Bank reference ' || v_ref, 200),
    p_sales_note  => 'Added from the bank statement');
  v_pay_id := (v_res ->> 'payment_request_id')::uuid;

  insert into public.bank_line_payment_links (line_id, payment_id, amount, linked_by)
  values (p_line_id, v_pay_id, v_line.deposit, v_actor);

  -- Verifies on the spot only for a self-verifier; otherwise changes nothing.
  v_done := public.complete_payment_entry(v_pay_id);

  select human_payment_id, status into v_human, v_status
    from public.finance_payment_requests where id = v_pay_id;

  return jsonb_build_object(
    'payment_request_id', v_pay_id,
    'request_number',     v_res ->> 'request_number',
    'human_payment_id',   v_human,
    'status',             v_status,
    'verified_on_entry',  coalesce((v_done ->> 'verified_on_entry')::boolean, false));
end;
$fn$;

comment on function public.create_payment_from_bank_line(uuid, boolean) is
  'Adds an unlinked bank credit as a Suspense payment (via submit_payment_request), links it to the line and verifies it at once only for a verify_own_payment holder / admin. Refuses duplicates. Needs finance.reconcile and finance.create. 20270419000000.';

revoke all on function public.create_payment_from_bank_line(uuid, boolean) from public, anon;
grant execute on function public.create_payment_from_bank_line(uuid, boolean) to authenticated;
