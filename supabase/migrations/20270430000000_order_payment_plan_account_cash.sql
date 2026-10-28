-- Orders: Payment plan — account and cash kept apart (owner, 2026-10-29).
--
-- WHY
--   The client pays the BILLED part (billing %) plus all GST into the company
--   account, and the rest in cash. The sheet must say how much is still due in
--   each, from the confirmed payments, with account and cash advances managed
--   separately.
--
-- WHAT THIS DOES
--   1. finance_payment_mode_is_account(mode): the one definition of "account"
--      money — HDFC PRI (hdfc), HDFC SEC (hdfc_sec), and the legacy bank
--      transfer / cheque / UPI records. Everything else is cash: PNB, Paytm,
--      Canara (owner: "Canara is cash only") and legacy cash / other.
--   2. order_payment_plans gains advance_account_override and
--      advance_cash_override (typed advances, each NULL = use Finance's
--      figure). The single advance_override of 20270428000000 is no longer
--      read or written; it stays for history.
--   3. order_payment_plan_read re-issued: the plan carries both typed advances;
--      Finance totals are also split into account and cash (verified and
--      awaiting). Still totals only — no payer, proof or payment id.
--   4. order_payment_plan_save: the 5-argument form is replaced by a 6-argument
--      one taking both typed advances.
--
-- ROLLBACK
--   Re-run §4 and §5 of 20270428000000 (the old read and save), then
--   drop function public.order_payment_plan_save(uuid, numeric, numeric, numeric, numeric, text);
--   drop function public.finance_payment_mode_is_account(text);
--   alter table public.order_payment_plans drop column advance_account_override, drop column advance_cash_override;

do $dep$
begin
  if to_regprocedure('public.order_payment_plan_assert(uuid, boolean)') is null
     or to_regprocedure('public.order_payment_plan_read(uuid)') is null
     or to_regprocedure('public.order_payment_plan_save(uuid, numeric, numeric, numeric, text)') is null then
    raise exception 'DEPENDENCY MISSING: 20270428000000 (Orders Payment plan) must be applied first';
  end if;
end $dep$;


-- ═══ §1. What counts as account money ═══════════════════════════════════════

create or replace function public.finance_payment_mode_is_account(p_mode text)
returns boolean
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select coalesce(p_mode in ('hdfc', 'hdfc_sec', 'bank_transfer', 'cheque', 'upi'), false)
$$;
comment on function public.finance_payment_mode_is_account(text) is
  'Payment plan: true for money received into the company account (HDFC PRI, HDFC SEC, legacy bank transfer / cheque / UPI). Everything else, Canara included, is cash (20270430000000).';


-- ═══ §2. Two typed advances ═════════════════════════════════════════════════

alter table public.order_payment_plans
  add column if not exists advance_account_override numeric(14,2)
    check (advance_account_override is null or advance_account_override >= 0),
  add column if not exists advance_cash_override numeric(14,2)
    check (advance_cash_override is null or advance_cash_override >= 0);

comment on column public.order_payment_plans.advance_override is
  'Superseded by advance_account_override / advance_cash_override (20270430000000); no longer read or written.';


-- ═══ §3. Read ═══════════════════════════════════════════════════════════════

create or replace function public.order_payment_plan_read(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_sub public.order_submissions%rowtype;
  v_items jsonb;
  v_plan jsonb;
  v_lots jsonb;
  v_fin jsonb;
begin
  perform public.order_payment_plan_assert(p_order_id, false);

  select * into v_order from public.orders where id = p_order_id;
  if not found then
    return jsonb_build_object('found', false);
  end if;
  select * into v_sub from public.order_submissions where id = v_order.source_order_submission_id;
  if not found then
    return jsonb_build_object('found', true, 'has_pi', false,
                              'order', jsonb_build_object('id', v_order.id, 'display_number', v_order.display_number));
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'item_sequence', coalesce(nullif(btrim(i.item_sequence), ''), i.id::text),
           'product_name', i.product_name,
           'quantity', i.quantity,
           'rate', i.cost_per_piece,
           'line_total', i.total_amount
         ) order by i.sort_order), '[]'::jsonb)
    into v_items
    from public.order_submission_items i
   where i.submission_id = v_sub.id;

  select jsonb_build_object(
           'pending_percent', p.pending_percent,
           'billing_percent', p.billing_percent,
           'advance_account_override', p.advance_account_override,
           'advance_cash_override', p.advance_cash_override,
           'note', p.note,
           'updated_at', p.updated_at)
    into v_plan
    from public.order_payment_plans p
   where p.order_id = p_order_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id,
           'lot_no', t.lot_no,
           'status', t.status,
           'planned_on', t.planned_on,
           'dispatched_on', t.dispatched_on,
           'lines', (select coalesce(jsonb_agg(jsonb_build_object(
                         'item_sequence', l.item_sequence, 'quantity', l.quantity)
                         order by l.item_sequence), '[]'::jsonb)
                       from public.order_dispatch_lot_lines l where l.lot_id = t.id)
         ) order by t.lot_no), '[]'::jsonb)
    into v_lots
    from public.order_dispatch_lots t
   where t.order_id = p_order_id;

  select jsonb_build_object(
           'verified', coalesce(sum(a.allocated_amount) filter (where public.finance_payment_status_is_verified(r.status)), 0),
           'awaiting', coalesce(sum(a.allocated_amount) filter (where r.status in ('pending_approval', 'needs_clarification')), 0),
           'payment_count', count(*) filter (where r.status <> 'rejected'),
           'account_verified', coalesce(sum(a.allocated_amount) filter (
              where public.finance_payment_status_is_verified(r.status) and public.finance_payment_mode_is_account(r.payment_mode)), 0),
           'account_awaiting', coalesce(sum(a.allocated_amount) filter (
              where r.status in ('pending_approval', 'needs_clarification') and public.finance_payment_mode_is_account(r.payment_mode)), 0),
           'cash_verified', coalesce(sum(a.allocated_amount) filter (
              where public.finance_payment_status_is_verified(r.status) and not public.finance_payment_mode_is_account(r.payment_mode)), 0),
           'cash_awaiting', coalesce(sum(a.allocated_amount) filter (
              where r.status in ('pending_approval', 'needs_clarification') and not public.finance_payment_mode_is_account(r.payment_mode)), 0))
    into v_fin
    from public.finance_payment_allocations a
    join public.finance_payment_requests r on r.id = a.payment_request_id
   where a.order_id = p_order_id
     and a.status = 'active'
     and r.deleted_at is null;

  return jsonb_build_object(
    'found', true,
    'has_pi', true,
    'order', jsonb_build_object(
      'id', v_order.id,
      'display_number', v_order.display_number,
      'status', v_order.status,
      'total_value', v_order.total_value,
      'client_name', v_sub.client_name),
    'pi', jsonb_build_object(
      'gross_product_amount', v_sub.gross_product_amount,
      'discount_amount', v_sub.discount_amount,
      'subtotal_after_discount', v_sub.subtotal_after_discount,
      'fabric_cost', v_sub.fabric_cost,
      'packing_cost', v_sub.packing_cost,
      'transportation_amount', v_sub.transportation_amount,
      'transportation_text', v_sub.transportation_text,
      'total_before_gst', v_sub.total_before_gst,
      'gst_amount', v_sub.gst_amount,
      'grand_total', v_sub.grand_total,
      'billing_percentage', v_sub.billing_percentage),
    'items', v_items,
    'plan', v_plan,
    'lots', v_lots,
    'finance', v_fin
  );
end;
$$;
revoke all on function public.order_payment_plan_read(uuid) from public, anon;
grant execute on function public.order_payment_plan_read(uuid) to authenticated;


-- ═══ §4. Save: both typed advances ══════════════════════════════════════════

drop function public.order_payment_plan_save(uuid, numeric, numeric, numeric, text);

create or replace function public.order_payment_plan_save(
  p_order_id uuid,
  p_pending_percent numeric,
  p_billing_percent numeric,
  p_advance_account numeric,
  p_advance_cash numeric,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform public.order_payment_plan_assert(p_order_id, true);

  if p_pending_percent is null or p_pending_percent < 0 or p_pending_percent > 100
     or p_pending_percent <> round(p_pending_percent, 2) then
    raise exception 'PAYMENT_PLAN_PERCENT_INVALID: pending' using errcode = '22023';
  end if;
  if p_billing_percent is not null
     and (p_billing_percent < 0 or p_billing_percent > 100 or p_billing_percent <> round(p_billing_percent, 2)) then
    raise exception 'PAYMENT_PLAN_PERCENT_INVALID: billing' using errcode = '22023';
  end if;
  if (p_advance_account is not null and (p_advance_account < 0 or p_advance_account <> round(p_advance_account, 2)))
     or (p_advance_cash is not null and (p_advance_cash < 0 or p_advance_cash <> round(p_advance_cash, 2))) then
    raise exception 'PAYMENT_PLAN_ADVANCE_INVALID' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception 'PAYMENT_PLAN_NOTE_TOO_LONG' using errcode = '22023';
  end if;

  insert into public.order_payment_plans as p
    (order_id, pending_percent, billing_percent, advance_account_override, advance_cash_override, note, updated_by, updated_at)
  values (p_order_id, p_pending_percent, p_billing_percent, p_advance_account, p_advance_cash, v_note, auth.uid(), now())
  on conflict (order_id) do update
    set pending_percent = excluded.pending_percent,
        billing_percent = excluded.billing_percent,
        advance_account_override = excluded.advance_account_override,
        advance_cash_override = excluded.advance_cash_override,
        note = excluded.note,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;
end;
$$;
revoke all on function public.order_payment_plan_save(uuid, numeric, numeric, numeric, numeric, text) from public, anon;
grant execute on function public.order_payment_plan_save(uuid, numeric, numeric, numeric, numeric, text) to authenticated;


-- ═══ §5. Self-assertions (executed) ═════════════════════════════════════════

do $assert$
begin
  if not public.finance_payment_mode_is_account('hdfc') or not public.finance_payment_mode_is_account('hdfc_sec')
     or public.finance_payment_mode_is_account('canara') or public.finance_payment_mode_is_account('pnb')
     or public.finance_payment_mode_is_account('paytm') or public.finance_payment_mode_is_account('cash')
     or public.finance_payment_mode_is_account(null) then
    raise exception 'ASSERT: account / cash split is wrong';
  end if;
  if to_regprocedure('public.order_payment_plan_save(uuid, numeric, numeric, numeric, text)') is not null then
    raise exception 'ASSERT: the old 5-argument save must be gone';
  end if;
  if not has_function_privilege('authenticated', 'public.order_payment_plan_save(uuid, numeric, numeric, numeric, numeric, text)', 'execute')
     or has_function_privilege('anon', 'public.order_payment_plan_save(uuid, numeric, numeric, numeric, numeric, text)', 'execute') then
    raise exception 'ASSERT: the new save must be callable by authenticated only';
  end if;
end $assert$;
