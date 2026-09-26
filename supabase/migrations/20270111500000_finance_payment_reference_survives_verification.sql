-- ════════════════════════════════════════════════════════════════════════════
-- 20270111500000 — A PAYMENT'S REFERENCE SURVIVES VERIFICATION
-- ════════════════════════════════════════════════════════════════════════════
--
-- THE DEFECT (found in the #209 acceptance review, 2026-09-26; live since
-- 20261014000000 / 20261118000000):
--
--   * record_pi_submission_payment_core and record_payment_with_allocations_core
--     store the "Reference / UTR" a person types in finance_payment_requests.
--     order_number (20261014000000 §6), with no order_id.
--   * approve_finance_payment_request (20261118000000) sets
--     order_number = <the linked Order's number, or NULL> when Finance
--     verifies. The reference is overwritten and gone; the activity log never
--     recorded it.
--   * The verification modal reads the reference from proof_note, which those
--     two doors never write — so Finance never saw it even before verifying.
--
-- THE FIX, and only this:
--
--   §1  A BEFORE INSERT trigger COPIES a typed reference into proof_note when a
--       row arrives with order_number set, no order_id and no proof_note — the
--       exact shape only those two doors produce (submit_payment_request_core
--       writes proof_note itself; an Order-linked row carries order_id).
--       order_number is left exactly as written: finance_payment_requests_
--       derive_target and every existing reader keep seeing what they saw.
--       Verification never writes proof_note, so the reference survives it.
--   §2  UNVERIFIED rows carried forward: the same copy, for rows not yet
--       verified (pending_approval, needs_clarification, rejected) whose
--       order_number still holds what was typed. VERIFIED rows are left
--       alone: their order_number was already overwritten, and nothing here
--       invents a reference for them.
--   §3  pi_submission_payment_summary's per-payment 'reference' reads
--       proof_note (it read order_number, which after verification is an
--       Order number or NULL — never the reference). The function is otherwise
--       byte-for-byte the definition in force (20261119000000).
--
-- Independent of #209 (20270112–16): #209 never writes order_number or
-- proof_note on this table, and redefines none of these functions.

-- ── §1 ──────────────────────────────────────────────────────────────────────
create or replace function public.finance_payment_requests_keep_reference()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if new.proof_note is null
     and new.order_id is null
     and nullif(btrim(coalesce(new.order_number, '')), '') is not null then
    new.proof_note := btrim(new.order_number);
  end if;
  return new;
end;
$fn$;

comment on function public.finance_payment_requests_keep_reference() is
  'A payment''s typed Reference / UTR, copied from order_number into proof_note on insert (only when there is no order_id and no proof_note), so that verification — which rewrites order_number — cannot erase it. 20270111500000.';

revoke execute on function public.finance_payment_requests_keep_reference() from public, anon, authenticated;

drop trigger if exists finance_payment_requests_keep_reference on public.finance_payment_requests;
create trigger finance_payment_requests_keep_reference
  before insert on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_keep_reference();

-- ── §2 ──────────────────────────────────────────────────────────────────────
-- A one-off, audited data carry-forward. The row guards on this table judge a
-- change by the columns it touches; proof_note on an unverified row is the
-- field its submitter may already edit, so this passes them as that edit would.
update public.finance_payment_requests f
   set proof_note = btrim(f.order_number)
 where f.proof_note is null
   and f.order_id is null
   and nullif(btrim(coalesce(f.order_number, '')), '') is not null
   and f.status in ('pending_approval', 'needs_clarification', 'rejected');

-- ── §3 ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pi_submission_payment_summary(p_submission_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor     uuid := auth.uid();
  v_sub       public.order_submissions%rowtype;
  v_verified  numeric := 0;
  v_unverif   numeric := 0;
  v_attached  numeric := 0;
  v_total     numeric;
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
  v_required := public.order_submission_required_payment(v_total);
  v_meets    := v_required is not null and v_verified >= v_required;
  v_attached_meets := v_required is not null and v_attached >= v_required;

  v_exc_current := public.order_submission_exception_current(
    v_sub.advance_exception_status,
    v_sub.advance_exception_decided_grand_total,     v_sub.grand_total,
    v_sub.advance_exception_decided_workbook_sha256, v_sub.source_workbook_sha256,
    v_sub.advance_exception_decided_payment_terms,   v_sub.payment_terms,
    v_sub.advance_exception_decided_billing_terms,   v_sub.billing_terms);

  v_position := case
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
    'verified_amount',      v_verified,
    'unverified_amount',    v_unverif,
    'attached_amount',      v_attached,
    'verified_percent',     case when v_total is null or v_total = 0 then null
                                 else trunc(v_verified * 100 / v_total, 2) end,
    'unverified_percent',   case when v_total is null or v_total = 0 then null
                                 else trunc(v_unverif  * 100 / v_total, 2) end,
    'attached_percent',     case when v_total is null or v_total = 0 then null
                                 else trunc(v_attached * 100 / v_total, 2) end,
    'needed_for_standard',  public.order_submission_payment_shortfall(v_total, v_verified),
    'needed_attached_for_submission',
                            public.order_submission_payment_shortfall(v_total, v_attached),
    'required_payment',     v_required,
    'meets_standard',       v_meets,
    'attached_meets_standard', v_attached_meets,
    'approval_position',    v_position,
    'submission_position',  v_sub_position,
    'order_gate_cleared',   (v_meets or v_exc_current),
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


-- ── Assertions ──
do $chk$
begin
  if not exists (select 1 from pg_trigger where tgname = 'finance_payment_requests_keep_reference' and tgrelid = 'public.finance_payment_requests'::regclass) then
    raise exception 'ASSERT: finance_payment_requests_keep_reference trigger missing';
  end if;
  if position('f.proof_note' in pg_get_functiondef('public.pi_submission_payment_summary'::regproc)) = 0 then
    raise exception 'ASSERT: pi_submission_payment_summary does not read proof_note';
  end if;
  if has_function_privilege('authenticated', 'public.finance_payment_requests_keep_reference()', 'EXECUTE') then
    raise exception 'ASSERT: the trigger function is not callable by clients';
  end if;
end
$chk$;
