-- Order Management — a declared billing percentage, on the PI and on the Order.
--
-- WHAT CHANGES, IN ONE SENTENCE
-- -----------------------------
-- `order_submissions` and `public.orders` each gain a nullable
-- `billing_percentage numeric(5,2)`, constrained to NULL or 35–100, set only
-- through a dedicated RPC under the authority that already governs editing a PI.
--
-- WHAT IT MEANS
-- -------------
-- How much of the PI's PRE-GST value should be billed. It is a commercial
-- decision somebody takes and declares. It is NOT a discount, NOT a payment
-- percentage, and NOT anything the workbook carries — no parser writes it, and
-- nothing derives it from another figure.
--
-- WHY NULL IS A REAL STATE, AND WHY NOTHING IS BACKFILLED
-- -------------------------------------------------------
-- Undeclared is not 0% and it is not 100%. A PI nobody has decided about and a
-- PI somebody decided to bill in full are different facts, and a default would
-- make the second unprovable — every historical row would claim a decision
-- nobody took. So: nullable, no DEFAULT, and no UPDATE over existing rows.
--
-- WHO MAY DECLARE ONE
-- -------------------
-- Exactly who may already edit the PI: public.can_edit_order_submission, which
-- is the owner or an active admin, and only while the record is in one of the
-- two employee-owned states (draft, needs_changes). A SUBMITTED PI is read-only
-- for everyone including reviewers — that is the existing model, stated in that
-- function's own comment, and this migration does not widen it. Management that
-- wants a different percentage returns the PI through Needs Changes.
--
-- No new permission and no new authority function is introduced here.
--
-- THE BOUNDS ARE STATED THREE TIMES AND MUST NOT DRIFT
-- ----------------------------------------------------
-- The CHECK constraints below are what actually holds. src/lib/orders/
-- billingPercentage.ts states the same bounds for the form, and the RPC states
-- them again so a caller is told why rather than hitting a constraint error.
-- src/lib/orders/billingPercentage.test.ts pins every boundary.
--
-- OPTIONAL, ALWAYS. Nothing here blocks submission or approval of a PI whose
-- percentage is undeclared. There is no new gate.
--
-- SAFE AND IDEMPOTENT. Columns and constraints are added IF NOT EXISTS / only
-- when absent, and no row is written, so re-running changes nothing.

begin;

-- ── 1. The columns ────────────────────────────────────────────────────────────

alter table public.order_submissions
  add column if not exists billing_percentage numeric(5,2);

alter table public.orders
  add column if not exists billing_percentage numeric(5,2);

comment on column public.order_submissions.billing_percentage is
  'How much of total_before_gst should be billed, as a percentage. NULL means undeclared — never 0 and never 100. Set only via set_order_submission_billing_percentage().';

comment on column public.orders.billing_percentage is
  'The billing percentage the source PI carried at approval, copied verbatim by approve_order_submission(). NULL when the PI was undeclared.';

-- ── 2. The bounds ─────────────────────────────────────────────────────────────
--
-- NOT VALID is deliberately NOT used: there is nothing to validate, because no
-- existing row has a value. Adding the constraint outright therefore cannot
-- fail and cannot lock anything for long.

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'order_submissions_billing_percentage_range'
      and conrelid = 'public.order_submissions'::regclass
  ) then
    alter table public.order_submissions
      add constraint order_submissions_billing_percentage_range
      check (billing_percentage is null
             or (billing_percentage >= 35 and billing_percentage <= 100));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'orders_billing_percentage_range'
      and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_billing_percentage_range
      check (billing_percentage is null
             or (billing_percentage >= 35 and billing_percentage <= 100));
  end if;
end $$;

-- ── 3. The write path ─────────────────────────────────────────────────────────
--
-- One RPC, doing one thing. p_percentage NULL is the CLEAR — returning the PI
-- to undeclared — which is a real edit and is logged like any other.
--
-- WHY NOT replace_order_submission_parse: that function writes what the
-- workbook said. This is what a person decided, and folding a human declaration
-- into the parse path would mean re-uploading a file to change a percentage —
-- and would risk a re-parse silently discarding it.
--
-- NO-OP DETECTION IS PART OF THE CONTRACT. Saving the value that is already
-- there writes nothing and logs nothing, so the Activity trail records changes
-- rather than visits.

create or replace function public.set_order_submission_billing_percentage(
  p_submission_id uuid,
  p_percentage    numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := auth.uid();
  v_sub      public.order_submissions%rowtype;
  v_previous numeric(5,2);
  v_next     numeric(5,2);
begin
  if v_actor is null then
    raise exception 'You must be signed in to change the billing percentage'
      using errcode = '42501';
  end if;

  -- The row lock is taken BEFORE the authority check for the same reason every
  -- other write path here does it: the state the check reads must be the state
  -- the write applies to.
  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  -- THE EXISTING AUTHORITY, UNCHANGED AND UNWIDENED. draft/needs_changes only,
  -- owner or active admin only, and only while the PI has no Order.
  if not public.can_edit_order_submission(p_submission_id) then
    raise exception
      'ORDER_SUBMISSION_BILLING_NOT_EDITABLE: this PI cannot be changed by you in its current state'
      using errcode = '42501';
  end if;

  v_previous := v_sub.billing_percentage;

  if p_percentage is null then
    v_next := null;
  else
    -- Stated here as well as in the constraint so the caller is told what is
    -- wrong rather than being handed a constraint violation.
    if not (p_percentage >= 35 and p_percentage <= 100) then
      raise exception
        'ORDER_SUBMISSION_BILLING_OUT_OF_RANGE: the billing percentage must be between 35 and 100'
        using errcode = 'P0001';
    end if;
    -- numeric(5,2) would round silently; refusing is the honest answer to a
    -- precision this column cannot hold.
    if scale(p_percentage) > 2 then
      raise exception
        'ORDER_SUBMISSION_BILLING_PRECISION: the billing percentage may have at most two decimal places'
        using errcode = 'P0001';
    end if;
    v_next := p_percentage;
  end if;

  -- NOTHING CHANGED: no write, no event. `is distinct from` is what makes this
  -- true for the NULL cases as well.
  if v_next is not distinct from v_previous then
    return jsonb_build_object(
      'submission_id',      p_submission_id,
      'billing_percentage', v_next,
      'changed',            false
    );
  end if;

  update public.order_submissions
  set billing_percentage = v_next,
      updated_at         = now()
  where id = p_submission_id;

  perform public.log_order_submission_activity(
    p_submission_id,
    v_actor,
    'billing_percentage_set',
    v_sub.status,
    v_sub.status,
    null,
    jsonb_build_object(
      'previous_billing_percentage', v_previous,
      'new_billing_percentage',      v_next
    )
  );

  return jsonb_build_object(
    'submission_id',      p_submission_id,
    'billing_percentage', v_next,
    'changed',            true
  );
end;
$$;

comment on function public.set_order_submission_billing_percentage(uuid, numeric) is
  'Declares, changes or clears a PI billing percentage under can_edit_order_submission (draft/needs_changes, owner or active admin). NULL clears it to undeclared. Saving an unchanged value writes nothing and logs nothing.';

revoke all    on function public.set_order_submission_billing_percentage(uuid, numeric) from public, anon;
grant  execute on function public.set_order_submission_billing_percentage(uuid, numeric) to authenticated;

-- ── 4. Approval carries it onto the Order ─────────────────────────────────────
--
-- approve_order_submission is re-emitted below for ONE reason: the Order it
-- creates must record the percentage the PI carried. The function is otherwise
-- byte-for-byte the definition 20260922000000 put in force — same signature,
-- same return type, same security definer, same search_path, same row locks,
-- same verified-payment gate, same numbering, same allocation move.
--
-- src/lib/orders/billingContinuity.test.ts proves that mechanically: it removes
-- the two added lines from this text and requires what is left to equal the
-- applied definition line for line.
--
-- NOTHING IS RECOMPUTED AND NOTHING IS DEFAULTED. An undeclared PI produces an
-- Order with a NULL billing_percentage.

create or replace function public.approve_order_submission(p_submission_id uuid)
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

  -- ── 6. Finance verification must be CURRENT ──
  --
  -- SEPARATE FROM, AND NOT A SUBSTITUTE FOR, VERIFIED PAYMENT. This is the
  -- Finance check on the PI's FIGURES (20260915000000 §11): somebody with
  -- finance authority has read the commercial summary and signed off on it. It
  -- says nothing about money arriving, it is not set by verifying a payment, and
  -- verifying a payment does not set it. Both are required; neither stands in
  -- for the other. And because it goes stale the moment the record moves, a PI
  -- corrected after the check must be checked again.
  if not public.order_submission_finance_verified(
       v_sub.finance_verified_at, v_sub.finance_verified_submission_at, v_sub.submitted_at) then
    raise exception
      'ORDER_SUBMISSION_FINANCE_NOT_VERIFIED: this PI has not been verified by finance for the submission under review'
      using errcode = 'P0001';
  end if;

  -- ── 6a. The total the requirement is a percentage of ──
  --
  -- Moved up from step 9 verbatim — same code, same message — because step 7 now
  -- needs it. Nothing else about the check changed.
  if v_sub.grand_total is null then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: this PI has no stored grand total'
      using errcode = 'P0001';
  end if;

  -- ── 7. The PAYMENT gate, live, under locks ──
  --
  -- Parent payments first, then allocations, both in id order. See the header.
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

  -- WHICH ROUTE, decided in the order the business decides it: money first, then
  -- the decision that stands in for money. A PI that meets the requirement needs
  -- no exception even if it once asked for one.
  --
  -- AN APPROVED EXCEPTION MUST STILL BE AN APPROVAL OF *THIS* PI. The decision
  -- was taken against a grand total, a workbook and a set of collection terms;
  -- if any of them has moved since, the approver agreed to something else.
  -- order_submission_exception_current() is the whole rule, and a decision with
  -- no recorded basis — every pre-Phase-3 one — is never current, because it was
  -- a decision about a declared advance rather than about verified payment.
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
    -- ONE REASON, THE MOST ACTIONABLE ONE, in business language and never a
    -- database error. A pending or refused decision is somebody's next step and
    -- is said first; otherwise the figure is what is missing.
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

    -- APPROVED, BUT NOT OF THIS PI. Said in its own words, because "not enough
    -- payment" would send the salesperson to collect money when what is actually
    -- needed is for the approver to look again.
    if v_sub.advance_exception_status = 'approved' then
      raise exception
        'ORDER_SUBMISSION_EXCEPTION_STALE: The reduced-payment approval was given for different commercial terms and must be approved again.'
        using errcode = 'P0001';
    end if;

    -- UNVERIFIED MONEY IS NAMED, NEVER COUNTED. Somebody reading "₹4,00,000 more
    -- is required" while looking at a ₹4,00,000 payment they entered this
    -- morning would conclude the system had lost it. It has not; Finance has
    -- not decided it yet, and an approved exception would not change that either.
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
  v_now := now();
  perform set_config('boe.pi_submission_approval_id', p_submission_id::text, true);

  -- ── 13. Exactly one Order ──
  --   due_date             the submission's own due_date, CARRIED ACROSS
  --                        UNCHANGED. It was already validated once — by the
  --                        parser on save or by 20260922000000's backfill, both
  --                        applying src/lib/orders/dueDate.ts — so it is copied,
  --                        never re-derived. NULL stays NULL: a submission with
  --                        no due date makes an Order with no due date, and
  --                        dispatch_commitment is still never read here.
  insert into public.orders (
    client_name, requested_by, confirm_date, due_date, total_value, total_product_value,
    billing_percentage,
    created_by, status, source_order_submission_id
  )
  values (
    v_client,
    v_sub.submitted_by,
    coalesce(v_sub.order_confirmation_date, v_now::date),
    v_sub.due_date,
    v_sub.grand_total,
    v_sub.gross_product_amount,
    -- The declaration the PI carried, verbatim. Never recomputed, never
    -- defaulted: an undeclared PI produces an undeclared Order.
    v_sub.billing_percentage,
    v_actor,
    'running',
    p_submission_id
  )
  returning id, display_number into v_order_id, v_number;

  -- ── 14. The submission becomes approved, and names its Order ──
  update public.order_submissions
     set status      = 'approved',
         approved_by = v_actor,
         approved_at = v_now,
         order_id    = v_order_id
   where id = p_submission_id;

  -- ── 14a. The money follows the record. It is MOVED, never copied. ──
  --
  -- ONE UPDATE. No INSERT, no DELETE, no second allocation, no payment row and
  -- no touch of finance_payment_requests: the SAME rows, keeping their ids, their
  -- payment_request_id, their amounts, their created_by, their created_at and
  -- their origin_target_type, simply stop naming the PI and start naming the
  -- Order. Everything a person could audit about where the money came from
  -- survives, because nothing about it is rewritten.
  --
  -- ACTIVE ROWS ONLY. A reversed allocation is history that belongs to the PI it
  -- was reversed against, and moving it would rewrite that history — the §5 guard
  -- refuses it in any case.
  --
  -- WHY IT IS SAFE HERE AND NOWHERE ELSE. The Order exists (step 13), so
  -- orders.source_order_submission_id is written and the §5 guard can tie the
  -- destination to this PI; the approval marker is open (step 12); and the whole
  -- thing is inside the transaction that creates the Order, so a failure at any
  -- later point leaves neither an Order, nor a number, nor a moved allocation.
  --
  -- THE CAPACITY TRIGGER STILL RUNS on every one of these rows and still passes:
  -- the amount is unchanged, so the payment's active allocated total is unchanged.
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

  -- NOTHING MAY BE LEFT BEHIND. §4c's lock order is what guarantees it: every
  -- writer that can create an allocation against this PI takes the submission
  -- lock we have held since step 2, so none can have landed since. This is the
  -- proof rather than the mechanism — if the guarantee ever stopped holding, an
  -- Order would be created with money stranded on a PI that no longer counts it,
  -- and that must be a loud refusal rather than a silent loss.
  select count(*) into v_stranded
  from public.finance_payment_allocations
  where order_submission_id = p_submission_id and status = 'active';

  if v_stranded > 0 then
    raise exception
      'ORDER_SUBMISSION_ALLOCATION_NOT_MOVED: % allocation(s) still name this PI after conversion; no Order may be created over stranded money',
      v_stranded
      using errcode = 'P0001';
  end if;

  -- ── 15. Both trails ──
  --
  -- The approval event now records WHY it was allowed. Not a separate event: the
  -- route is not a thing that happened, it is the reason the thing that happened
  -- was permitted, and a reader of one row should not have to correlate two.
  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'approved', 'submitted', 'approved', null,
    jsonb_build_object(
      'order_id',             v_order_id,
      'order_display_number', v_number,
      'item_count',           v_item_count,
      'payment_route',        v_route,
      'verified_payment',     v_verified,
      'required_payment',     v_required,
      'grand_total',          v_sub.grand_total
    )
  );

  -- The move, on the PI, as its own event — because it is its own fact, and the
  -- PI's reader needs to know the money is no longer counted here.
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
      'moved_allocated_total',     v_moved_amount
    )
  );

  -- ── 16. Close the context before returning ──
  perform set_config('boe.pi_submission_approval_id', '', true);

  -- ── 17. Identifiers only. Nothing the caller could not already read. ──
  return jsonb_build_object(
    'submission_id',    p_submission_id,
    'order_id',         v_order_id,
    'display_number',   v_number,
    'already_approved', false,
    'payment_route',    v_route,
    'moved_allocations', v_moved_count
  );
end;
$$;

-- The grants 20260915000000 made are on the function NAME and SIGNATURE, which
-- have not changed, so CREATE OR REPLACE keeps them. Restated here so that an
-- environment which somehow lost them is repaired by re-running this migration.
revoke all on function public.approve_order_submission(uuid) from public;
grant execute on function public.approve_order_submission(uuid) to authenticated;

-- ── 5. What was deliberately NOT done ─────────────────────────────────────────
--
-- NO DEFAULT. Not 100, not 0, not anything. The column's whole value is that it
-- distinguishes declared from undeclared.
--
-- NO BACKFILL. Every existing submission and every existing Order stays NULL.
--
-- NO SUBMISSION OR APPROVAL GATE. A PI may be submitted and approved while
-- undeclared. Management that needs a percentage uses Needs Changes.
--
-- NO SECOND MONETARY COLUMN. The billing VALUE is total_before_gst × the
-- percentage; deriving it keeps one source of truth, where storing it would
-- create a figure that could disagree with its own inputs.
--
-- NO NEW AUTHORITY. can_edit_order_submission is used exactly as it stands. A
-- submitted PI remains uneditable by everyone, reviewers included.
--
-- NO ORDER-SIDE EDITOR. orders.billing_percentage is written once, by approval.
-- Changing it on a confirmed Order is a separate piece of work with its own
-- authority question.

commit;
