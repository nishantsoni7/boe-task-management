-- ═══════════════════════════════════════════════════════════════════════════
-- FOUR FIELDS A CONFIRMED ORDER CANNOT BE BUILT WITHOUT
--
-- Salesperson, confirm date, due date and lead source are business facts an
-- Order is worked from every day, and until now the conversion could not carry
-- any of them:
--
--   assigned_to   NOTHING in the entire system ever wrote it. Not the
--                 conversion, not amend_order, not a client — no role holds
--                 INSERT on public.orders and no definer function set it. Every
--                 Confirmed Order in production has it null, which is why the
--                 Order screen has always said "Unassigned".
--   lead_source   the conversion never set it either; only a later amendment
--                 could, and almost none ever did.
--   confirm_date  was taken from the PI, or silently defaulted to the day of
--                 approval — a date nobody chose.
--   due_date      was taken from the PI, where it is null whenever the document
--                 stated a commitment ("6 weeks from confirmation") rather than
--                 a calendar date. See src/lib/orders/dueDate.ts.
--
-- So the four are now REQUIRED INPUTS to the function that creates an Order.
-- They are validated BEFORE ANY CONVERSION-SIDE STATE CHANGE OR ORDER CREATION
-- — after the actor is authorized and the submission row is locked and read,
-- which is what the checks are judged against, and before the payment position
-- is read, before any allocation moves, and before the Order exists.
--
-- ── DATABASE-FIRST ROLLOUT: NOTHING HERE BREAKS THE DEPLOYED FRONTEND ───────
--
-- This migration is applied BEFORE the new frontend ships, and the currently
-- deployed frontend must not be able to hurt anybody in the window between the
-- two. So BOTH signatures exist after it:
--
--   approve_order_submission(uuid)
--       KEPT, and turned into a REFUSAL (§1). It creates nothing. A tab that
--       was loaded before the release calls it, is told to refresh, and cannot
--       create an Order without the four fields. That is the entire point of
--       keeping it: a dropped function would answer PGRST202 "function not
--       found", which is not something a person can act on, and every stale tab
--       in the company would show it as an unexplained failure.
--
--   approve_order_submission(uuid, uuid, date, date, text)
--       NEW, and the only thing that creates an Order (§2).
--
-- WHY THE OVERLOAD IS NOT AMBIGUOUS, and this is the part that must not be
-- guessed at: NEITHER SIGNATURE TAKES A DEFAULT. PostgREST picks an overload by
-- matching the SET OF ARGUMENT NAMES in the request body against each
-- candidate's parameters, and a candidate is only eligible when every parameter
-- without a default was supplied. So {p_submission_id} can satisfy the
-- one-argument function alone, and {p_submission_id, p_assigned_to,
-- p_confirm_date, p_due_date, p_lead_source} can satisfy the five-argument one
-- alone. Giving any of the four a DEFAULT would make BOTH eligible for the
-- one-key body and produce PGRST203 "could not choose the best candidate
-- function" for every approval. §3 asserts pronargdefaults = 0 on both, which
-- is the single most likely way a later edit breaks this.
--
-- The same rule, the same reasoning and the same assertion are already
-- deployed for accept_employee_asset — see 20261029000000 §6c(ii).
--
-- ── FOLLOW-UP CLEANUP, TO BE DONE IN A LATER MIGRATION ──────────────────────
--
--   Once the new frontend is in production and no client is calling the
--   one-argument form any more:
--
--       DROP FUNCTION IF EXISTS public.approve_order_submission(uuid);
--
--   Do NOT do it here, and do not do it in the same release as the frontend.
--   Nothing is lost by leaving it: it refuses every call.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
-- ----------------------------------
-- NO NOT NULL CONSTRAINT. public.orders keeps every one of these columns
-- nullable. Historical Orders carry nulls, they are legitimate business
-- history, and a constraint would refuse to let them be read or amended. The
-- rule belongs to the act of CREATING an Order, so it lives in the function
-- that creates one.
--
-- NO SECOND CONVERSION PATH. approve_order_submission(uuid, uuid, date, date,
-- text) remains the only way an Order comes into existence: no client role
-- holds INSERT on public.orders (20260819000000 §1), and the Order Request
-- conversion functions were revoked from every client role when that workflow
-- was retired (20261007000000).
--
-- AND THE BLOCKER GUESSES NOTHING. It does not call the new function with
-- defaults, does not derive a salesperson, does not invent a lead source, does
-- not fall back to today, and does not read a due date out of prose. There is
-- no such thing as a nearly-complete Order: it refuses.
--
-- NOTHING ELSE IN THE FUNCTION MOVES. The body below is the deployed text of
-- 20261124000000 with three edits: the signature, the validation block, and the
-- INSERT. Every authorization check, the row lock, the finance gate, the
-- payment routes, the diagnostics, the workbook and image checks, the moved
-- allocations, the PI version, both activity trails and the return shape are
-- byte-for-byte what they were.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. The one-argument form STAYS, and refuses ──────────────────────────────
--
-- CREATE OR REPLACE, never DROP: replacing the body keeps the function's OID,
-- its grants and its resolvability, so a deployed tab gets a sentence it can
-- act on instead of a missing-function error.
--
-- It is no longer SECURITY DEFINER. It reads nothing, writes nothing and
-- decides nothing, so it needs no privileges of its own — and a definer
-- function that does nothing is a privilege nobody should have to reason about
-- again.

create or replace function public.approve_order_submission(p_submission_id uuid)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $blocker$
begin
  -- p_submission_id is deliberately unread. There is no submission this can
  -- legitimately approve, and looking one up would only invite somebody to
  -- "just default the missing fields from it" later.
  raise exception
    'ORDER_CONFIRMATION_CLIENT_UPDATE_REQUIRED: Refresh this page before confirming the Order. Salesperson, confirm date, due date and lead source are now required.'
    using errcode = 'P0001';
end;
$blocker$;

comment on function public.approve_order_submission(uuid) is
  'COMPATIBILITY BLOCKER, not a conversion. Creates nothing and refuses every call with ORDER_CONFIRMATION_CLIENT_UPDATE_REQUIRED. It exists only so a browser tab loaded before 20261201000000 gets an actionable sentence instead of a missing-function error, and cannot create an Order without a salesperson, a confirm date, a due date and a lead source. Drop it in a later migration once the new frontend is in production.';

revoke execute on function public.approve_order_submission(uuid) from public, anon;
grant  execute on function public.approve_order_submission(uuid) to authenticated;

-- ── 2. The conversion, with the four fields it now requires ──────────────────

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
  if not public.actor_has_module_permission('orders', 'approve_order') then
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

  -- ── 6. Finance verification must be CURRENT ──
  if not public.order_submission_finance_verified(
       v_sub.finance_verified_at, v_sub.finance_verified_submission_at, v_sub.submitted_at) then
    raise exception
      'ORDER_SUBMISSION_FINANCE_NOT_VERIFIED: this PI has not been verified by finance for the submission under review'
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

comment on function public.approve_order_submission(uuid, uuid, date, date, text) is
  'THE ONLY way a Confirmed Order comes into existence. Requires a salesperson, a confirm date, a due date and a lead source, validated before any conversion-side state change or Order creation — after the actor is authorized and the submission row is locked and read, and before the payment position is read, before any allocation moves and before the Order exists. The four are written onto the Order. Historical Orders keep their nulls: public.orders has no NOT NULL constraint on any of them. Every other rule (authorization, the row lock, finance verification, the payment routes, diagnostics, the workbook and image checks, the moved allocations, the PI version and both trails) is unchanged from 20261124000000. The one-argument overload still exists and refuses every call — see §1.';

revoke execute on function public.approve_order_submission(uuid, uuid, date, date, text) from public, anon;
grant  execute on function public.approve_order_submission(uuid, uuid, date, date, text) to authenticated;

-- ── 3. The migration proves its own claims ───────────────────────────────────
--
-- EXECUTED, not asserted in prose: a migration that describes a needle its own
-- function does not contain would pass a text test and abort on apply.

do $assert$
declare
  v_new text := pg_get_functiondef(
    to_regprocedure('public.approve_order_submission(uuid, uuid, date, date, text)'));
  v_old text := pg_get_functiondef(
    to_regprocedure('public.approve_order_submission(uuid)'));
  v_n   integer;
begin
  -- 3a. BOTH signatures exist. This is the whole rollout: the new one converts,
  --     the old one refuses, and neither is missing.
  if v_new is null then
    raise exception 'ASSERTION FAILED: approve_order_submission(uuid, uuid, date, date, text) does not exist';
  end if;
  if v_old is null then
    raise exception 'ASSERTION FAILED: the one-argument approve_order_submission is missing — a tab loaded before this release would get a missing-function error instead of being told to refresh';
  end if;

  -- 3b. AND THERE ARE ONLY THOSE TWO. A third overload would be another way to
  --     create an Order, or another candidate for PostgREST to choose between.
  select count(*) into v_n
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'approve_order_submission';
  if v_n <> 2 then
    raise exception 'ASSERTION FAILED: approve_order_submission has % overloads, expected exactly 2', v_n;
  end if;

  -- 3c. NEITHER DECLARES A DEFAULT. This is what keeps the overload resolvable:
  --     a default on any of the four would make the five-argument function
  --     eligible for a {p_submission_id} body as well, and PostgREST would
  --     answer PGRST203 "could not choose the best candidate function" for
  --     every approval instead of picking one. The same guard 20261029000000
  --     §6c(ii) already runs for accept_employee_asset.
  select count(*) into v_n
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'approve_order_submission'
    and p.pronargdefaults > 0;
  if v_n <> 0 then
    raise exception 'ASSERTION FAILED: % approve_order_submission overload(s) declare a DEFAULT; that makes the PostgREST call ambiguous (PGRST203)', v_n;
  end if;

  -- 3d. THE BLOCKER REFUSES, AND CREATES NOTHING.
  if v_old !~ 'ORDER_CONFIRMATION_CLIENT_UPDATE_REQUIRED' then
    raise exception 'ASSERTION FAILED: the one-argument form does not carry the update-required refusal';
  end if;
  if v_old ~* 'insert\s+into' then
    raise exception 'ASSERTION FAILED: the one-argument form can still create a row';
  end if;
  if v_old ~* 'delete\s+from' or v_old ~* '\mupdate\M\s+\w' then
    raise exception 'ASSERTION FAILED: the one-argument form writes something; it must only refuse';
  end if;
  -- It must not quietly hand the work to the new function with invented values,
  -- and must not read a submission in order to invent them. It has no SELECT
  -- and no PERFORM at all: there is nothing it needs to know. A name match is
  -- NOT the test — the CREATE header names the function itself — but a call or
  -- a lookup would need one of these two keywords.
  if v_old ~* '\mselect\M' or v_old ~* '\mperform\M' then
    raise exception 'ASSERTION FAILED: the one-argument form reads or delegates; it must only refuse';
  end if;

  -- 3e. THE FOUR GATES ARE IN THE FUNCTION THAT CREATES AN ORDER.
  if v_new !~ 'ORDER_CONFIRMATION_SALESPERSON_REQUIRED' then
    raise exception 'ASSERTION FAILED: the salesperson gate is missing';
  end if;
  if v_new !~ 'ORDER_CONFIRMATION_CONFIRM_DATE_REQUIRED' then
    raise exception 'ASSERTION FAILED: the confirm-date gate is missing';
  end if;
  if v_new !~ 'ORDER_CONFIRMATION_DUE_DATE_REQUIRED' then
    raise exception 'ASSERTION FAILED: the due-date gate is missing';
  end if;
  if v_new !~ 'ORDER_CONFIRMATION_LEAD_SOURCE_REQUIRED' then
    raise exception 'ASSERTION FAILED: the lead-source gate is missing';
  end if;

  -- 3f. AND THE FOUR VALUES REACH THE ROW.
  if v_new !~ 'assigned_to' then
    raise exception 'ASSERTION FAILED: the INSERT does not carry the salesperson';
  end if;
  if v_new !~ 'p_assigned_to' or v_new !~ 'p_confirm_date'
     or v_new !~ 'p_due_date' or v_new !~ 'v_lead_source' then
    raise exception 'ASSERTION FAILED: the INSERT does not carry all four given values';
  end if;
  if v_new ~ 'coalesce\(v_sub\.order_confirmation_date' then
    raise exception 'ASSERTION FAILED: the confirm date still falls back to today';
  end if;

  -- 3g. HISTORICAL ORDERS ARE NOT BROKEN: the table was not tightened.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name in ('assigned_to', 'confirm_date', 'due_date', 'lead_source')
      and is_nullable = 'NO'
  ) then
    raise exception 'ASSERTION FAILED: a required column was made NOT NULL, which would break historical Orders';
  end if;
end
$assert$;
commit;
