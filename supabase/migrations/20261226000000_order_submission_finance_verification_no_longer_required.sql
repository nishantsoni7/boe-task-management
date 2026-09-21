-- The PI-level finance verification is no longer a step.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT WAS WRONG
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A PI could not become an Order until TWO separate approvals had been given
-- for the same question — has Finance looked at the money?
--
--   1. PI-LEVEL FINANCE VERIFICATION. verify_pi_finance_check() stamped
--      finance_verified_by/_at/_submission_at on the submission, and
--      approve_order_submission() and approve_pi_review() both refused without
--      a CURRENT one.
--   2. PER-PAYMENT VERIFICATION. Finance approves each reported payment, and
--      order_submission_verified_payment() counts only approved_unlinked and
--      approved_linked allocations toward the 40% requirement.
--
-- The second is the one that decides anything: it is derived from actual money
-- that a finance authority has actually accepted. The first was a signature on
-- the document, given by the same authority, adding no fact the second did not
-- already carry — and a reviewer holding a PI whose every rupee was verified
-- still had to chase it.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT THIS MIGRATION DOES
-- ═════════════════════════════════════════════════════════════════════════════
--
-- REMOVES the finance-verification requirement from the two doors that carried
-- it, and ADDS to the order-creating door the rule that was actually meant:
--
--   approve_pi_review           no longer requires a current PI-level finance
--                               verification. Every other check is copied
--                               character for character.
--   approve_order_submission    no longer requires one either (§6 deleted), and
--                               gains §7b: NO payment attached to the PI may be
--                               awaiting Finance's decision, whatever the
--                               payment route says.
--
-- §7b IS NOT COSMETIC. Before it, a PI that met 40% in verified money could be
-- approved while a SECOND payment against it sat undecided — v_route resolved
-- to 'standard' and the existing AWAITING_VERIFICATION branch, which lives
-- inside the route-is-null arm, never ran. The screen had the same hole, for
-- the same reason: pi_submission_payment_summary() resolves 'standard_met'
-- before it looks at unverified money. The gate is enforced HERE, under the
-- row lock, so a direct PostgREST call cannot walk past it.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT IS DELIBERATELY UNTOUCHED
-- ═════════════════════════════════════════════════════════════════════════════
--
--   * NO SCHEMA CHANGE. No column added, altered or dropped.
--   * NO DML. Not one row is read, written or deleted by this migration.
--   * verify_pi_finance_check() still exists, still runs, still records a
--     verification, and still holds its grants. Nothing REQUIRES its result.
--   * finance_verified_by, finance_verified_at and
--     finance_verified_submission_at keep every value ever written to them, and
--     order_submission_finance_verified() is still there to read them with.
--     Historical verifications and their activity entries are evidence of what
--     happened, and this migration does not revise history.
--   * can_verify_pi_finance() and the finance.approve permission are unchanged.
--     Who may verify a PAYMENT is exactly who could yesterday.
--   * Both signatures, both return types, security definer, the search_path and
--     every grant are re-stated below exactly as they stood.
--
-- REVERSIBILITY. Re-applying 20261224000000's two function bodies restores the
-- previous behaviour exactly; nothing here destroys the state that would be
-- needed to do it.

create or replace function public.approve_pi_review(p_submission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.assert_order_submission_actor();
  v_sub   public.order_submissions%rowtype;
  v_now   timestamptz;
begin
  if not public.actor_can_approve_order() then
    raise exception 'You do not have permission to approve order submissions'
      using errcode = '42501';
  end if;

  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  if v_sub.deletion_claim_token is not null then
    raise exception
      'ORDER_SUBMISSION_DELETION_CLAIMED: this PI is reserved for deletion and cannot be approved'
      using errcode = '55P03';
  end if;

  if v_sub.status <> 'submitted' then
    raise exception
      'ORDER_SUBMISSION_NOT_UNDER_REVIEW: only a submitted PI can be approved (this one is %)', v_sub.status
      using errcode = 'P0001';
  end if;

  if jsonb_array_length(v_sub.parse_blocking_issues) > 0 then
    raise exception
      'ORDER_SUBMISSION_BLOCKED: % issue(s) in this PI must be fixed before it can be approved',
      jsonb_array_length(v_sub.parse_blocking_issues)
      using errcode = 'P0001';
  end if;

  -- Already decided against THIS submission: answer, do not re-record.
  if public.order_submission_pi_approved(
       v_sub.pi_approved_at, v_sub.pi_approved_submission_at, v_sub.submitted_at) then
    return jsonb_build_object(
      'id',               p_submission_id,
      'pi_approved',      true,
      'pi_approved_at',   v_sub.pi_approved_at,
      'already_approved', true
    );
  end if;

  v_now := now();

  update public.order_submissions
     set pi_approved_by            = v_actor,
         pi_approved_at            = v_now,
         pi_approved_submission_at = v_sub.submitted_at
   where id = p_submission_id;

  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'pi_approved', 'submitted', 'submitted', null,
    jsonb_build_object(
      'approved_submission_at', v_sub.submitted_at,
      'order_created',          false
    )
  );

  return jsonb_build_object(
    'id',               p_submission_id,
    'pi_approved',      true,
    'pi_approved_at',   v_now,
    'already_approved', false
  );
end;
$$;

create or replace function public.approve_order_submission(
  p_submission_id uuid,
  p_assigned_to   uuid,
  p_confirm_date  date,
  p_due_date      date,
  p_lead_source   text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor        uuid := public.assert_order_submission_actor();
  v_sub          public.order_submissions%rowtype;
  v_order_id     uuid;
  v_number       text;
  v_now          timestamptz;
  v_item_count   integer;
  v_bad          integer;
  v_bad_row      integer;
  v_client       text;
  v_verified     numeric;
  v_unverified   numeric;
  v_required     numeric;
  v_shortfall    numeric;
  v_route        text;
  v_exception_current boolean;
  v_moved_count  integer := 0;
  v_moved_amount numeric := 0;
  v_stranded     integer;
  v_pi_stamped   boolean := false;
  v_codes        jsonb;
  v_lead_source  text;
  v_salesperson  uuid;
begin
  -- ── 1. Authorization, server-side, before anything is read ──
  if not public.actor_can_approve_order() then
    raise exception 'You do not have permission to approve order submissions'
      using errcode = '42501';
  end if;

  -- ── 2. The lock, before any mutable state is judged ──
  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  -- ── 3. Already approved: answer with what exists ──
  if v_sub.status = 'approved' and v_sub.order_id is not null then
    select o.display_number into v_number
    from public.orders o where o.id = v_sub.order_id;

    return jsonb_build_object(
      'submission_id',    p_submission_id,
      'order_id',         v_sub.order_id,
      'display_number',   v_number,
      'already_approved', true
    );
  end if;

  -- ── 4. A deletion reservation freezes the record for everybody ──
  if v_sub.deletion_claim_token is not null then
    raise exception
      'ORDER_SUBMISSION_DELETION_CLAIMED: this PI is reserved for deletion and cannot be approved'
      using errcode = '55P03';
  end if;

  -- ── 5. Only a submitted PI can be approved ──
  if v_sub.status <> 'submitted' then
    raise exception
      'ORDER_SUBMISSION_NOT_UNDER_REVIEW: only a submitted PI can be approved (this one is %)', v_sub.status
      using errcode = 'P0001';
  end if;

  if v_sub.order_id is not null then
    raise exception
      'ORDER_SUBMISSION_ALREADY_LINKED: this PI is already linked to an Order'
      using errcode = 'P0001';
  end if;

  -- ── 5b. The four fields a Confirmed Order cannot be built without ──
  --
  -- WHY HERE. Before the payment gate, before the diagnostics, before the
  -- workbook and image checks and before anything is written: a conversion
  -- refused for a missing field must leave the PI exactly as it found it.
  --
  -- WHY IN THE DATABASE. The screen asks for all four and will not submit
  -- without them, and that is a courtesy rather than a control. A stale client,
  -- a replayed request and a hand-made PostgREST call all arrive here.
  --
  -- HISTORICAL ORDERS ARE UNTOUCHED. This is a rule about CREATING an Order,
  -- expressed in the function that creates one. public.orders keeps every
  -- column nullable, so the Orders that predate this migration still read and
  -- still open.
  if p_assigned_to is null then
    raise exception
      'ORDER_CONFIRMATION_SALESPERSON_REQUIRED: a salesperson is required before an Order can be confirmed'
      using errcode = 'P0001';
  end if;

  select id into v_salesperson from public.users where id = p_assigned_to;
  if v_salesperson is null then
    raise exception
      'ORDER_CONFIRMATION_SALESPERSON_UNKNOWN: that salesperson is not a BOE user'
      using errcode = 'P0001';
  end if;

  if p_confirm_date is null then
    raise exception
      'ORDER_CONFIRMATION_CONFIRM_DATE_REQUIRED: a confirm date is required before an Order can be confirmed'
      using errcode = 'P0001';
  end if;

  if p_due_date is null then
    raise exception
      'ORDER_CONFIRMATION_DUE_DATE_REQUIRED: a due date is required before an Order can be confirmed'
      using errcode = 'P0001';
  end if;

  v_lead_source := nullif(btrim(coalesce(p_lead_source, '')), '');
  if v_lead_source is null then
    raise exception
      'ORDER_CONFIRMATION_LEAD_SOURCE_REQUIRED: a lead source is required before an Order can be confirmed'
      using errcode = 'P0001';
  end if;

  -- The SAME five values public.orders has always accepted. The CHECK
  -- constraint would refuse anything else at the INSERT; naming it here means
  -- the refusal is a sentence about the field rather than a constraint name.
  if v_lead_source not in ('reference', 'repeat_customer', 'whatsapp', 'instagram', 'website') then
    raise exception
      'ORDER_CONFIRMATION_LEAD_SOURCE_INVALID: that lead source is not one BOE records'
      using errcode = 'P0001';
  end if;

  v_now := now();

  -- ── 6b. The PI decision, if it has not been taken against this submission ──
  if not public.order_submission_pi_approved(
       v_sub.pi_approved_at, v_sub.pi_approved_submission_at, v_sub.submitted_at) then
    update public.order_submissions
       set pi_approved_by            = v_actor,
           pi_approved_at            = v_now,
           pi_approved_submission_at = v_sub.submitted_at
     where id = p_submission_id;
    v_pi_stamped := true;
    v_sub.pi_approved_by            := v_actor;
    v_sub.pi_approved_at            := v_now;
    v_sub.pi_approved_submission_at := v_sub.submitted_at;
  end if;

  -- ── 6a. The total the requirement is a percentage of ──
  if v_sub.grand_total is null then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: this PI has no stored grand total'
      using errcode = 'P0001';
  end if;

  -- ── 7. The PAYMENT gate, live, under locks ──
  perform 1
  from public.finance_payment_requests f
  where f.id in (
    select a.payment_request_id
    from public.finance_payment_allocations a
    where a.order_submission_id = p_submission_id
  )
  order by f.id
  for update;

  perform 1
  from public.finance_payment_allocations a
  where a.order_submission_id = p_submission_id
  order by a.id
  for update;

  v_verified   := public.order_submission_verified_payment(p_submission_id);
  v_unverified := public.order_submission_unverified_payment(p_submission_id);
  v_required   := public.order_submission_required_payment(v_sub.grand_total);
  v_shortfall  := public.order_submission_payment_shortfall(v_sub.grand_total, v_verified);

  v_exception_current := public.order_submission_exception_current(
    v_sub.advance_exception_status,
    v_sub.advance_exception_decided_grand_total,     v_sub.grand_total,
    v_sub.advance_exception_decided_workbook_sha256, v_sub.source_workbook_sha256,
    v_sub.advance_exception_decided_payment_terms,   v_sub.payment_terms,
    v_sub.advance_exception_decided_billing_terms,   v_sub.billing_terms);

  if v_verified >= v_required then
    v_route := 'standard';
  elsif v_exception_current then
    v_route := 'exception';
  else
    v_route := null;
  end if;

  if v_route is null then
    if v_sub.advance_exception_status = 'pending' then
      raise exception
        'ORDER_SUBMISSION_EXCEPTION_PENDING: The reduced-payment exception is still pending.'
        using errcode = 'P0001';
    end if;

    if v_sub.advance_exception_status = 'rejected' then
      raise exception
        'ORDER_SUBMISSION_EXCEPTION_REJECTED: The reduced-payment exception was rejected. Update the PI before resubmitting.'
        using errcode = 'P0001';
    end if;

    if v_sub.advance_exception_status = 'approved' then
      raise exception
        'ORDER_SUBMISSION_EXCEPTION_STALE: The reduced-payment approval was given for different commercial terms and must be approved again.'
        using errcode = 'P0001';
    end if;

    if v_unverified > 0 then
      raise exception
        'ORDER_SUBMISSION_PAYMENT_AWAITING_VERIFICATION: Payment is awaiting Finance verification. % more verified payment is required for standard approval, or Admin approval is required to proceed below 40%%.',
        '₹' || to_char(v_shortfall, 'FM999999999990.00')
        using errcode = 'P0001';
    end if;

    raise exception
      'ORDER_SUBMISSION_PAYMENT_INSUFFICIENT: % more verified payment is required for standard approval. Admin approval is required to proceed below 40%%.',
      '₹' || to_char(v_shortfall, 'FM999999999990.00')
      using errcode = 'P0001';
  end if;

  -- ── 7b. NOTHING MAY STILL BE WITH FINANCE (20261226000000) ──
  --
  -- THE CASE THE ROUTE ABOVE CANNOT REFUSE. v_route is resolved from VERIFIED
  -- money against the requirement, or from a current exception. Both can be
  -- satisfied while a SEPARATE payment against this same PI is still sitting
  -- with Finance undecided — and until this check existed, that PI could be
  -- turned into an Order with money in flight that nobody had agreed was real.
  --
  -- The branch above raises AWAITING_VERIFICATION too, but only when the PI is
  -- ALSO short. This one is unconditional, and it is the rule as stated: if any
  -- payment attached to this PI is awaiting verification, the Order is not
  -- created.
  --
  -- REJECTED AND REVERSED PAYMENTS ARE NOT THIS. order_submission_unverified_payment()
  -- counts only pending_approval and needs_clarification — money Finance has
  -- yet to decide. A rejected payment is decided, counts zero, and blocks
  -- nothing here, exactly as it did before.
  if v_unverified > 0 then
    raise exception
      'ORDER_SUBMISSION_PAYMENT_AWAITING_VERIFICATION: a payment attached to this PI is awaiting Finance verification and must be verified before the Order can be created'
      using errcode = 'P0001';
  end if;

  -- ── 8. No blocking diagnostics ──
  if jsonb_array_length(v_sub.parse_blocking_issues) > 0 then
    raise exception
      'ORDER_SUBMISSION_BLOCKED: % issue(s) in this PI must be fixed before it can be approved',
      jsonb_array_length(v_sub.parse_blocking_issues)
      using errcode = 'P0001';
  end if;

  -- ── 9. The fields an Order cannot be built without ──
  v_client := nullif(btrim(coalesce(v_sub.client_name, '')), '');
  if v_client is null then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: a client name is required'
      using errcode = 'P0001';
  end if;

  -- ── 10. The workbook: shape, then existence, then type ──
  if coalesce(btrim(v_sub.source_workbook_path), '') = '' then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: the uploaded workbook is missing'
      using errcode = 'P0001';
  end if;

  if v_sub.source_workbook_path !~
     ('^submissions/' || p_submission_id::text || '/original/[^/]+$') then
    raise exception
      'ORDER_SUBMISSION_BAD_WORKBOOK_PATH: the workbook is not stored under submissions/%/original/', p_submission_id
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'order-files'
      and o.name = v_sub.source_workbook_path
      and o.metadata ->> 'mimetype'
          = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) then
    raise exception
      'ORDER_SUBMISSION_WORKBOOK_NOT_STORED: the PI workbook is missing from storage, or is not an .xlsx file'
      using errcode = 'P0001';
  end if;

  -- ── 11. The product lines still satisfy the submission invariants ──
  select count(*) into v_item_count
  from public.order_submission_items where submission_id = p_submission_id;

  if v_item_count = 0 then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: at least one product line is required'
      using errcode = 'P0001';
  end if;

  select count(*) into v_bad
  from public.order_submission_items
  where submission_id = p_submission_id
    and (item_sequence is null or product_name is null);

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_INCOMPLETE: % product line(s) are missing an item sequence or a name',
      v_bad
      using errcode = 'P0001';
  end if;

  select count(*), min(i.source_row) into v_bad, v_bad_row
  from public.order_submission_items i
  where i.submission_id = p_submission_id
    and (
      select count(*) from public.order_submission_item_images m
      where m.item_id = i.id and m.role = 'representative'
    ) <> 1;

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_INCOMPLETE: % product line(s) do not have exactly one representative image (first at row %)',
      v_bad, v_bad_row
      using errcode = 'P0001';
  end if;

  select count(*) into v_bad
  from public.order_submission_item_images m
  where m.submission_id = p_submission_id
    and m.storage_path !~
        ('^submissions/' || p_submission_id::text || '/images/' || m.item_id::text
         || '/' || m.role || '/' || m.position::text || '-' || m.sha256
         || '\.(png|jpg|jpeg|webp)$');

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_BAD_IMAGE_PATH: % image path(s) do not name this submission and their own product line',
      v_bad
      using errcode = 'P0001';
  end if;

  select count(*), min(m.anchor_row) into v_bad, v_bad_row
  from public.order_submission_item_images m
  where m.submission_id = p_submission_id
    and not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'order-files'
        and o.name = m.storage_path
        and o.metadata ->> 'mimetype' in ('image/png', 'image/jpeg', 'image/webp')
    );

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_IMAGE_NOT_STORED: % image(s) are missing from storage or are not a PNG, JPEG or WEBP (first anchored at row %)',
      v_bad, v_bad_row
      using errcode = 'P0001';
  end if;

  -- ── 12. Everything holds. Open the approval context. ──
  perform set_config('boe.pi_submission_approval_id', p_submission_id::text, true);

  if v_pi_stamped then
    perform public.log_order_submission_activity(
      p_submission_id, v_actor, 'pi_approved', 'submitted', 'submitted', null,
      jsonb_build_object(
        'approved_submission_at', v_sub.submitted_at,
        'order_created',          true
      )
    );
  end if;

  -- ── 13. Exactly one Order ──
  insert into public.orders (
    client_name, requested_by, assigned_to, confirm_date, due_date,
    total_value, total_product_value, lead_source,
    billing_percentage,
    created_by, status, source_order_submission_id
  )
  values (
    v_client,
    v_sub.submitted_by,
    p_assigned_to,
    p_confirm_date,
    p_due_date,
    v_sub.grand_total,
    v_sub.gross_product_amount,
    v_lead_source,
    v_sub.billing_percentage,
    v_actor,
    'running',
    p_submission_id
  )
  returning id, display_number into v_order_id, v_number;

  -- ── 13b. Permanent BOE item codes, assigned the moment the Order exists ──
  v_codes := public.assign_order_product_codes(v_order_id, v_actor);

  -- ── 14. The submission becomes approved, and names its Order ──
  update public.order_submissions
     set status      = 'approved',
         approved_by = v_actor,
         approved_at = v_now,
         order_id    = v_order_id
   where id = p_submission_id;

  -- ── 14a. The money follows the record. It is MOVED, never copied. ──
  with moved as (
    update public.finance_payment_allocations
       set order_submission_id = null,
           order_id            = v_order_id
     where order_submission_id = p_submission_id
       and status = 'active'
    returning allocated_amount
  )
  select count(*), coalesce(sum(allocated_amount), 0)
    into v_moved_count, v_moved_amount
  from moved;

  select count(*) into v_stranded
  from public.finance_payment_allocations
  where order_submission_id = p_submission_id and status = 'active';

  if v_stranded > 0 then
    raise exception
      'ORDER_SUBMISSION_ALLOCATION_NOT_MOVED: % allocation(s) still name this PI after conversion; no Order may be created over stranded money',
      v_stranded
      using errcode = 'P0001';
  end if;

  -- ── 14b. V1 of the Order's PI history: the document it was approved from ──
  insert into public.order_pi_versions (
    order_id, submission_id, version_number, status,
    workbook_path, workbook_name, workbook_sha256,
    uploaded_by, uploaded_at, revision_reason,
    decided_by, decided_at
  ) values (
    v_order_id, p_submission_id, 1, 'approved',
    v_sub.source_workbook_path, v_sub.source_workbook_name, v_sub.source_workbook_sha256,
    coalesce(v_sub.submitted_by, v_sub.created_by), coalesce(v_sub.submitted_at, v_now), null,
    v_actor, v_now
  );

  -- ── 15. Both trails ──
  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'approved', 'submitted', 'approved', null,
    jsonb_build_object(
      'order_id',             v_order_id,
      'order_display_number', v_number,
      'item_count',           v_item_count,
      'payment_route',        v_route,
      'verified_payment',     v_verified,
      'unverified_payment',   v_unverified,
      'attached_payment',     v_verified + v_unverified,
      'required_payment',     v_required,
      'grand_total',          v_sub.grand_total,
      'pi_approved_at',       v_sub.pi_approved_at,
      'pi_approved_by',       v_sub.pi_approved_by
    )
  );

  if v_moved_count > 0 then
    perform public.log_order_submission_activity(
      p_submission_id, v_actor, 'payment_allocations_moved', 'approved', 'approved', null,
      jsonb_build_object(
        'order_id',           v_order_id,
        'allocation_count',   v_moved_count,
        'allocated_total',    v_moved_amount
      )
    );
  end if;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (
    v_order_id, v_actor, 'order_created_from_pi_submission',
    jsonb_build_object(
      'order_submission_id',       p_submission_id,
      'item_count',                v_item_count,
      'payment_route',             v_route,
      'moved_allocation_count',    v_moved_count,
      'moved_allocated_total',     v_moved_amount,
      'production_alignment',      'not_aligned'
    )
  );

  if jsonb_array_length(v_codes) > 0 then
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (
      v_order_id, v_actor, 'order_product_codes_assigned',
      jsonb_build_object('codes', v_codes)
    );
  end if;

  -- ── 16. Close the context before returning ──
  perform set_config('boe.pi_submission_approval_id', '', true);

  -- ── 17. Identifiers only. Nothing the caller could not already read. ──
  return jsonb_build_object(
    'submission_id',    p_submission_id,
    'order_id',         v_order_id,
    'display_number',   v_number,
    'already_approved', false
  );
end;
$$;

-- ── Privileges, re-stated exactly as they stood ──
--
-- `create or replace function` preserves a function's ACL, so these change
-- nothing. They are written out so the privilege set is readable in the
-- migration that last touched the function, rather than three files back.
revoke execute on function public.approve_pi_review(uuid) from public, anon;
grant  execute on function public.approve_pi_review(uuid) to authenticated;

revoke execute on function public.approve_order_submission(uuid, uuid, date, date, text) from public, anon;
grant  execute on function public.approve_order_submission(uuid, uuid, date, date, text) to authenticated;
