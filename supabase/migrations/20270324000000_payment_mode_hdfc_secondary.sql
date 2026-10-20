-- ════════════════════════════════════════════════════════════════════════════
-- 20270324000000 — TWO HDFC ACCOUNTS: 'hdfc' IS HDFC PRI, 'hdfc_sec' IS NEW
-- ════════════════════════════════════════════════════════════════════════════
--
-- BOE holds two HDFC accounts. Until now one stored value, 'hdfc', stood for
-- "HDFC", so a payment could not say which of the two received the money.
--
-- THE DECISION. 'hdfc' is KEPT and now means HDFC PRI (the primary account — the
-- only HDFC account every existing payment can have gone into). A new value,
-- 'hdfc_sec', means HDFC SEC (the secondary account). No row is rewritten: every
-- existing 'hdfc' row simply reads as HDFC PRI. If any history really went into
-- the secondary account, correcting that row is a normal payment edit.
--
-- WHAT CHANGES (the whole list, and why it is short)
--   1. finance_payment_requests.payment_mode CHECK learns 'hdfc_sec'.
--   2. payment_mode_is_current() learns 'hdfc_sec'. Every entry door — the four
--      payment RPCs, the edit RPC (20270322000000) and the enforce trigger —
--      asks THAT function, so none of them is redefined here.
--   3. The enforce trigger's refusal sentence names the five current accounts.
--      Only the sentence changes; the rule is the function's.
--
-- WHAT DOES NOT CHANGE. payment_mode_requires_custody(): only pnb and paytm are
-- carried by a person, so HDFC SEC has no custody trail, exactly like HDFC PRI.
-- public.expenses and expense_drafts have their own seven outgoing routes and no
-- HDFC value; they are untouched.
--
-- ORDERING. Apply BEFORE the code that offers HDFC SEC is deployed: without it
-- the database refuses 'hdfc_sec' and the form shows the generic payment error.
-- The migration is additive, so the OLD code keeps working after it is applied.
-- Rollback (only while no hdfc_sec row exists): restore the 4-value CHECK and
-- function body from 20261014000000 §1.
-- ════════════════════════════════════════════════════════════════════════════

do $dep$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.finance_payment_requests'::regclass
       and conname  = 'finance_payment_requests_payment_mode_current_or_legacy'
  ) then
    raise exception 'DEPENDENCY MISSING: finance_payment_requests_payment_mode_current_or_legacy (20261014000000)';
  end if;
  if to_regprocedure('public.payment_mode_is_current(text)') is null then
    raise exception 'DEPENDENCY MISSING: payment_mode_is_current(text) (20261014000000)';
  end if;
end
$dep$;

-- ── 1. The domain CHECK ─────────────────────────────────────────────────────
alter table public.finance_payment_requests
  drop constraint finance_payment_requests_payment_mode_current_or_legacy;

alter table public.finance_payment_requests
  add constraint finance_payment_requests_payment_mode_current_or_legacy
  check (payment_mode in (
    -- CURRENT — the five a new entry may use.
    'hdfc', 'hdfc_sec', 'pnb', 'paytm', 'canara',
    -- LEGACY — historical rows only, kept readable, refused for new entries.
    'bank_transfer', 'cash', 'upi', 'cheque', 'other'
  ));

comment on column public.finance_payment_requests.payment_mode is
  'How the money arrived, as one of the five BOE accounts a new entry may name: hdfc (HDFC PRI, primary current account), hdfc_sec (HDFC SEC, secondary current account), pnb (Hawala), paytm (Cash), canara (Saving Account). The five legacy values — bank_transfer, cash, upi, cheque, other — remain STORABLE so every historical row stays readable and is never rewritten, and remain REFUSED for new entries by finance_payment_requests_enforce_current_payment_mode. The bracketed meanings are internal and are never rendered by any screen. 20270324000000.';

-- ── 2. The one list every entry door reads ──────────────────────────────────
create or replace function public.payment_mode_is_current(p_mode text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select btrim(lower(coalesce(p_mode, ''))) in ('hdfc', 'hdfc_sec', 'pnb', 'paytm', 'canara');
$$;

comment on function public.payment_mode_is_current(text) is
  'True for the five payment modes a NEW entry may use: hdfc, hdfc_sec, pnb, paytm, canara. False for the five legacy values, which stay storable so history is never rewritten. 20270324000000.';

-- ── 3. The trigger's refusal sentence ───────────────────────────────────────
-- Body identical to 20261014000000 except the two sentences. CREATE OR REPLACE
-- keeps the function's revoked ACL and the trigger bound to it.
create or replace function public.finance_payment_requests_enforce_current_payment_mode()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if not public.payment_mode_is_current(new.payment_mode) then
      raise exception
        'PAYMENT_MODE_RETIRED: % is a historical payment mode. Choose HDFC PRI, HDFC SEC, PNB, Paytm or Canara.',
        new.payment_mode
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- UPDATE. Only a CHANGE is judged. Leaving a historical value exactly as it
  -- was found is what keeps every old row correctable.
  if new.payment_mode is distinct from old.payment_mode
     and not public.payment_mode_is_current(new.payment_mode) then
    raise exception
      'PAYMENT_MODE_RETIRED: % is a historical payment mode and cannot be set on a payment. Choose HDFC PRI, HDFC SEC, PNB, Paytm or Canara.',
      new.payment_mode
      using errcode = 'P0001';
  end if;

  return new;
end $$;

-- ── 4. Self-assertion (executed, not just written) ──────────────────────────
do $assert$
declare
  v_name text;
begin
  foreach v_name in array array['hdfc', 'hdfc_sec', 'pnb', 'paytm', 'canara'] loop
    if not public.payment_mode_is_current(v_name) then
      raise exception 'payment_mode_is_current refuses %', v_name;
    end if;
  end loop;
  foreach v_name in array array['bank_transfer', 'cash', 'upi', 'cheque', 'other', 'hdfc_secondary', ''] loop
    if public.payment_mode_is_current(v_name) then
      raise exception 'payment_mode_is_current accepts %', v_name;
    end if;
  end loop;
  if public.payment_mode_is_current(null) then
    raise exception 'payment_mode_is_current accepts NULL';
  end if;
  if public.payment_mode_requires_custody('hdfc_sec') then
    raise exception 'hdfc_sec must not require a custody trail';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.finance_payment_requests'::regclass
       and conname  = 'finance_payment_requests_payment_mode_current_or_legacy'
       and pg_get_constraintdef(oid) like '%hdfc_sec%'
  ) then
    raise exception 'the payment_mode CHECK does not name hdfc_sec';
  end if;
end
$assert$;
