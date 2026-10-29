-- Orders: Payment plan — fabric and packing per product (owner, 2026-10-29).
--
-- WHY
--   The owner's dispatch sheet (their reference "Req-0169") works fabric and
--   packing out PER PRODUCT: packing = quantity x packing rate, fabric =
--   quantity x metres per piece x fabric rate. The Payment plan now does the
--   same (src/lib/orders/paymentPlan.ts). A BDPI line already carries those
--   figures (20270503000000); a Confirmed Order's come from its PI's Fabric &
--   Finish sheet (order_submission_fabric_finish_lines, 20270431000000:
--   a typed value wins over the sheet's).
--
-- WHAT THIS DOES
--   order_payment_plan_read is re-issued exactly as 20270430000000 left it,
--   except that each item also carries fabric_metres_per_piece,
--   fabric_price_per_metre, packing_cost_per_piece, packing_type and
--   finish_specs (the fabric / finish chosen), and the PI block carries
--   discount_amount already (unchanged). Nothing is written anywhere.
--
-- ROLLBACK
--   Re-run §3 of 20270430000000_order_payment_plan_account_cash.sql.

do $dep$
begin
  if to_regprocedure('public.order_payment_plan_read(uuid)') is null
     or to_regprocedure('public.finance_payment_mode_is_account(text)') is null
     or to_regclass('public.order_submission_fabric_finish_lines') is null then
    raise exception 'DEPENDENCY MISSING: 20270430000000 and 20270431000000 must be applied first';
  end if;
end $dep$;

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
           'line_total', i.total_amount,
           'dimensions', i.dimensions,
           'material', i.material,
           'fabric_metres_per_piece', coalesce(f.typed_fabric_metres_per_piece, f.sheet_fabric_metres_per_piece),
           'fabric_price_per_metre', coalesce(f.typed_fabric_price_per_metre, f.sheet_fabric_price_per_metre),
           'packing_cost_per_piece', coalesce(f.typed_packing_cost_per_piece, f.sheet_packing_cost_per_piece),
           'packing_type', coalesce(f.typed_packing_type, f.sheet_packing_type),
           'finish_specs', case when f.typed_finish is not null and jsonb_array_length(f.typed_finish) > 0
                                then f.typed_finish else coalesce(f.sheet_finish, '[]'::jsonb) end
         ) order by i.sort_order), '[]'::jsonb)
    into v_items
    from public.order_submission_items i
    left join public.order_submission_fabric_finish_lines f
      on f.submission_id = i.submission_id
     and f.item_sequence = coalesce(nullif(btrim(i.item_sequence), ''), i.id::text)
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
