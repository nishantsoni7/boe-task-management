-- ═══════════════════════════════════════════════════════════════════════════
-- 20270505000000 — The PI payments popup names each payment by its Payment ID.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY (owner, 2026-10-29): the Confirmed payments popup on a PI printed the
-- request number (PAY-REQ-2026-0084). Everywhere else in Finance a payment is
-- known by its Payment ID (human_payment_id, P-AA-0021), and the popup must
-- show that instead.
--
-- WHAT CHANGES
--
--   pi_submission_payment_summary() — re-emitted from 20270227000000 verbatim
--   with ONE added key on each payment row: 'human_payment_id'. Every total,
--   position and permission check is unchanged, and so is 'request_number', so
--   a page built before this migration reads exactly the answer it always did.
--   CREATE OR REPLACE keeps the function's existing grants.
--
-- ROLLBACK: re-run the 20270227000000 definition of the function. Nothing is
-- stored and no row changes.

-- pi_submission_payment_summary: previous definition 20270227000000_order_submission_advance_on_total_before_gst.sql
CREATE OR REPLACE FUNCTION public.pi_submission_payment_summary(p_submission_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
set search_path = public, pg_temp
AS $function$
declare
  v_actor     uuid := auth.uid();
  v_sub       public.order_submissions%rowtype;
  v_verified  numeric := 0;
  v_unverif   numeric := 0;
  v_attached  numeric := 0;
  v_total     numeric;
  v_base      numeric;
  v_base_ok   boolean;
  v_required  numeric;
  v_meets      boolean;
  v_attached_meets boolean;
  v_exc_current boolean;
  v_position  text;
  v_sub_position text;
  v_pi_approved boolean;
  v_pi_approver text;
  v_is_admin  boolean;
  v_fin_all   boolean;
  v_rows      jsonb;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select * into v_sub from public.order_submissions where id = p_submission_id;

  if not found or not public.can_view_order_submission(p_submission_id) then
    raise exception 'ORDER_SUBMISSION_NOT_AVAILABLE: that PI is not available.'
      using errcode = '42501';
  end if;

  v_is_admin := exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin' and u.is_active
      and coalesce(u.is_deleted, false) = false
  );
  v_fin_all := public.actor_has_module_permission('finance', 'view_all');

  select
    coalesce(sum(a.allocated_amount) filter (
      where public.finance_payment_status_is_verified(f.status)), 0),
    coalesce(sum(a.allocated_amount) filter (
      where f.status in ('pending_approval', 'needs_clarification')), 0)
    into v_verified, v_unverif
  from public.finance_payment_allocations a
  join public.finance_payment_requests f on f.id = a.payment_request_id
  where a.order_submission_id = p_submission_id
    and a.status = 'active';

  v_attached := v_verified + v_unverif;
  v_total    := v_sub.grand_total;
  -- 20270227000000: every advance figure below is measured against the TOTAL
  -- BEFORE GST (advance_base). No usable base: percentages, required and
  -- shortfall are NULL and the gate is not cleared.
  v_base_ok  := v_sub.total_before_gst is not null and v_sub.total_before_gst <> 'NaN'::numeric and v_sub.total_before_gst > 0
                and v_sub.total_before_gst <= coalesce(v_sub.grand_total, v_sub.total_before_gst);
  v_base     := case when v_base_ok then v_sub.total_before_gst end;
  v_required := public.order_submission_required_payment(v_base);
  v_meets    := v_required is not null and v_verified >= v_required;
  v_attached_meets := v_required is not null and v_attached >= v_required;

  v_exc_current := public.order_submission_exception_current(
    v_sub.advance_exception_status,
    v_sub.advance_exception_decided_grand_total,     v_sub.grand_total,
    v_sub.advance_exception_decided_workbook_sha256, v_sub.source_workbook_sha256,
    v_sub.advance_exception_decided_payment_terms,   v_sub.payment_terms,
    v_sub.advance_exception_decided_billing_terms,   v_sub.billing_terms);

  v_position := case
    when not v_base_ok                               then 'payment_required'
    when v_meets                                     then 'standard_met'
    when v_exc_current                               then 'exception_approved'
    when v_sub.advance_exception_status = 'approved' then 'exception_stale'
    when v_sub.advance_exception_status = 'pending'  then 'exception_pending'
    when v_sub.advance_exception_status = 'rejected' then 'exception_rejected'
    when v_unverif > 0                               then 'verification_pending'
    else 'payment_required'
  end;

  -- WHERE THE SUBMISSION RULE STANDS, resolved here so the dialog that asks
  -- for a reason and the door that refuses without one read one answer.
  v_sub_position := case
    when v_attached_meets then 'attached_met'
    when v_attached > 0   then 'attached_partial'
    else 'no_payment'
  end;

  -- THE PI DECISION. On an approved record it is read straight, as the finance
  -- check is: the columns are deliberately kept, and submitted_at no longer
  -- moves.
  v_pi_approved := case
    when v_sub.status = 'approved' then v_sub.pi_approved_at is not null
    else public.order_submission_pi_approved(
           v_sub.pi_approved_at, v_sub.pi_approved_submission_at, v_sub.submitted_at)
  end;

  select u.full_name into v_pi_approver
  from public.users u where u.id = v_sub.pi_approved_by;

  select coalesce(jsonb_agg(r order by r->>'created_at' desc), '[]'::jsonb)
    into v_rows
  from (
    select jsonb_build_object(
      'allocation_id',     a.id,
      'allocation_status', a.status,
      'allocated_amount',  a.allocated_amount,
      'payment_id',        f.id,
      'request_number',    f.request_number,
      'human_payment_id',  f.human_payment_id,
      'amount',            f.amount,
      'payment_date',      f.payment_date,
      'payment_mode',      f.payment_mode,
      'reference',         f.proof_note,
      'remarks',           f.sales_note,
      'status',            f.status,
      'is_verified',       public.finance_payment_status_is_verified(f.status),
      'admin_note',        f.admin_note,
      'entered_by',        eb.full_name,
      'verified_by',       vb.full_name,
      'created_at',        f.created_at,
      'verified_at',       f.approved_at,
      'rejected_at',       f.rejected_at,
      'proof_count',       (select count(*) from public.payment_proof_attachments pa
                             where pa.payment_request_id = f.id),
      'can_view_proof',    (v_is_admin or f.submitted_by = v_actor)
    ) as r
    from public.finance_payment_allocations a
    join public.finance_payment_requests f on f.id = a.payment_request_id
    left join public.users eb on eb.id = f.submitted_by
    left join public.users vb on vb.id = f.approved_by
    where a.order_submission_id = p_submission_id
  ) t;

  return jsonb_build_object(
    'submission_id',        p_submission_id,
    'submission_status',    v_sub.status,
    'grand_total',          v_total,
    'advance_base',         v_base,
    'total_before_gst',     v_sub.total_before_gst,
    'advance_base_missing', not v_base_ok,
    'verified_amount',      v_verified,
    'unverified_amount',    v_unverif,
    'attached_amount',      v_attached,
    'verified_percent',     case when not v_base_ok then null
                                 else trunc(v_verified * 100 / v_base, 2) end,
    'unverified_percent',   case when not v_base_ok then null
                                 else trunc(v_unverif  * 100 / v_base, 2) end,
    'attached_percent',     case when not v_base_ok then null
                                 else trunc(v_attached * 100 / v_base, 2) end,
    'needed_for_standard',  public.order_submission_payment_shortfall(v_base, v_verified),
    'needed_attached_for_submission',
                            public.order_submission_payment_shortfall(v_base, v_attached),
    'required_payment',     v_required,
    'meets_standard',       v_meets,
    'attached_meets_standard', v_attached_meets,
    'approval_position',    v_position,
    'submission_position',  v_sub_position,
    'order_gate_cleared',   (v_base_ok and (v_meets or v_exc_current)),
    'pi_approved',          v_pi_approved,
    'pi_approved_at',       case when v_pi_approved then v_sub.pi_approved_at end,
    'pi_approved_by',       case when v_pi_approved then v_sub.pi_approved_by end,
    'pi_approved_by_name',  case when v_pi_approved then v_pi_approver end,
    'pending_balance',      case when v_total is null then null
                                 else greatest(v_total - v_verified, 0) end,
    'standard_percent',     public.order_submission_standard_advance_percent(),
    'advance_condition',    v_sub.advance_condition,
    'exception_status',     v_sub.advance_exception_status,
    'exception_current',    v_exc_current,
    'exception_reason',     v_sub.advance_exception_reason,
    'exception_rejection_reason', v_sub.advance_exception_rejection_reason,
    'payment_terms',        v_sub.payment_terms,
    'billing_terms',        v_sub.billing_terms,
    'can_view_all_finance', v_fin_all,
    'payments',             v_rows
  );
end;
$function$;
