-- Order Management — a real due date, and the end of reading a date out of prose.
--
-- WHAT CHANGES, IN ONE SENTENCE
-- -----------------------------
-- `order_submissions` gains a nullable `due_date date`, populated ONLY from an
-- explicit, plausible calendar date; the free-text dispatch commitment stays
-- exactly where it is, unchanged, and is never converted into a date.
--
-- WHY THE COLUMN HAS TO EXIST
-- ---------------------------
-- The PI's dispatch cell (Master E113) is read by the parser as a date value,
-- but `commitmentText()` has always stored only its `.text` into
-- `dispatch_commitment`, a TEXT column. That column therefore holds three
-- different kinds of thing today:
--
--   '2026-03-25'                          a real date, from a real Excel serial
--   '6 weeks from date of confirmation'   a commercial commitment, not a date
--   '90'                                  a lead time somebody typed as a number
--
-- Nothing downstream can tell the first from the third without a rule, and the
-- screen needs a date it can trust. So the date gets a typed column of its own
-- and the prose keeps the text column it always had.
--
-- THE TRAP THIS MIGRATION IS MOSTLY ABOUT
-- ---------------------------------------
-- `excelSerialToIso` (src/lib/pi/workbookReader.ts) rejects serials below 61 —
-- so "6" and "45" survived as the text "6" and "45", which no date rule will
-- ever match. But 61 and above WERE converted, and a lead time typed as a plain
-- number is already stored as a perfectly well-formed ISO date in 1900:
--
--     61 → 1900-03-01     90 → 1900-03-30     120 → 1900-04-29    365 → 1900-12-30
--
-- A backfill that trusted the ISO pattern alone would adopt every one of those
-- as a due date. The floor below is what stops it, and it is checked
-- unconditionally — not merely relative to the row's own anchor — because a row
-- whose dispatch cell was mis-parsed this way may well have a confirmation date
-- that was mis-parsed the same way, and a wrong anchor cannot vouch for a value.
--
-- THE RULE, WHICH IS STATED TWICE AND MUST NOT DRIFT
-- --------------------------------------------------
-- The identical rule lives in TypeScript at src/lib/orders/dueDate.ts
-- (`plausibleDueDate`) for the save path. src/lib/orders/dueDate.test.ts pins
-- every boundary in this comment so the two cannot quietly diverge.
--
--   1. strictly 'YYYY-MM-DD', and a real day (2026-02-30 is not)
--   2. >= 2020-01-01, ALWAYS — this is what "never a 1900 date" means
--   3. >= order_confirmation_date when the PI has one,
--      else >= creation_date when it has one,
--      else >= 2020-01-01 as the anchor of last resort
--
-- Anything failing any of these keeps due_date NULL and keeps its commitment
-- text untouched. No duration is ever parsed, and no date is ever calculated.
--
-- SAFE AND IDEMPOTENT. The column is added IF NOT EXISTS; the backfill only ever
-- writes rows where due_date IS NULL, so re-running changes nothing and cannot
-- overwrite a date a human later corrected.

begin;

-- ── 1. The column ─────────────────────────────────────────────────────────────

alter table public.order_submissions
  add column if not exists due_date date;

comment on column public.order_submissions.due_date is
  'The dispatch due date, ONLY when the PI stated an explicit, plausible calendar '
  'date (Master E113 as a real Excel date). Never derived from the prose in '
  'dispatch_commitment — see migration 20260922000000 and '
  'src/lib/orders/dueDate.ts. NULL means no due date has been established.';

-- ── 2. The backfill ───────────────────────────────────────────────────────────
--
-- `as materialized` is an optimisation fence, and it is load-bearing: it forces
-- the regex filter to run before any cast, so the parser below is never handed
-- '6 weeks from date of confirmation'.
--
-- WHY A HELPER FUNCTION AND NOT to_date(). An ISO-shaped string is not
-- necessarily a real day, and '2026-02-30' has to be rejected rather than
-- silently moved to March 2nd. PostgreSQL 16 RAISES on that input rather than
-- normalising it, so a `to_char(to_date(x))` round trip aborts the whole
-- migration instead of filtering the row. pg_input_is_valid() would answer this
-- exactly, but it is PG16-only and a Supabase project may still be on 15. A
-- temporary function with an exception handler works on both and disappears
-- with the session.

create function pg_temp.due_date_or_null(value text) returns date as $fn$
begin
  return value::date;
exception when others then
  return null;
end $fn$ language plpgsql immutable;

do $$
declare
  adopted    bigint;
  candidates bigint;
  remaining  bigint;
begin
  with candidate as materialized (
    select id, dispatch_commitment, order_confirmation_date, creation_date
      from public.order_submissions
     where due_date is null
       and dispatch_commitment ~ '^\d{4}-\d{2}-\d{2}$'
  ),
  checked as (
    select id,
           pg_temp.due_date_or_null(dispatch_commitment) as due,
           order_confirmation_date, creation_date
      from candidate
  ),
  updated as (
    update public.order_submissions s
       set due_date = c.due
      from checked c
     where s.id = c.id
       -- (1) ISO-shaped AND a real day
       and c.due is not null
       -- (2) the absolute floor
       and c.due >= date '2020-01-01'
       -- (3) on or after the record's own anchor
       and c.due >= coalesce(c.order_confirmation_date, c.creation_date, date '2020-01-01')
    returning s.id
  )
  select (select count(*) from updated), (select count(*) from candidate)
    into adopted, candidates;

  select count(*) into remaining
    from public.order_submissions where due_date is null;

  raise notice 'due_date backfill: % adopted, % ISO-shaped candidates rejected, % rows now null',
    adopted, candidates - adopted, remaining;
end $$;


-- ── 4. The save path writes the column ────────────────────────────────────────
--
-- replace_order_submission_parse() was last defined by 20260909000000 and is
-- re-emitted here VERBATIM apart from the single `due_date` assignment marked
-- below. Nothing else about the function changes — not its signature, its
-- security, its item handling, its image handling, or its return shape.
--
-- The value is decided in TypeScript (src/lib/orders/dueDate.ts) before the
-- payload is built. This function does not parse a date out of anything; it
-- stores the one it was handed, or NULL.

create or replace function public.replace_order_submission_parse(
  p_submission_id uuid,
  p_actor_id      uuid,
  p_payload       jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status      text;
  v_header      jsonb := coalesce(p_payload -> 'header', '{}'::jsonb);
  v_commercial  jsonb := coalesce(p_payload -> 'commercial', '{}'::jsonb);
  v_source      jsonb := coalesce(p_payload -> 'source', '{}'::jsonb);
  v_parse       jsonb := coalesce(p_payload -> 'parse', '{}'::jsonb);
  v_items       jsonb := coalesce(p_payload -> 'items', '[]'::jsonb);
  v_images      jsonb := coalesce(p_payload -> 'item_images', '[]'::jsonb);
  v_warnings    jsonb := coalesce(v_parse -> 'warnings', '[]'::jsonb);
  v_blocking    jsonb := coalesce(v_parse -> 'blocking_issues', '[]'::jsonb);
  v_count       integer;
  v_rep_count   integer;
  v_cust_count  integer;
  v_foreign     integer;
  v_fingerprint text := nullif(btrim(lower(coalesce(p_payload ->> 'fingerprint', ''))), '');
  v_previous    text;
  v_unchanged   boolean := false;
  -- Carried in the payload rather than as a fourth argument: `create or
  -- replace` cannot change a signature, and adding one would leave the old
  -- three-argument function in place as a token-free way in. The payload is
  -- built server-side by the same process that holds the lease.
  v_token       uuid := nullif(btrim(coalesce(p_payload ->> 'processing_token', '')), '')::uuid;
  v_held        uuid;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'ORDER_SUBMISSION_PAYLOAD_INVALID: a JSON object is required'
      using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_items) <> 'array' then
    raise exception 'ORDER_SUBMISSION_PAYLOAD_INVALID: items must be an array'
      using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_images) <> 'array' then
    raise exception 'ORDER_SUBMISSION_PAYLOAD_INVALID: item_images must be an array'
      using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_warnings) <> 'array' or jsonb_typeof(v_blocking) <> 'array' then
    raise exception 'ORDER_SUBMISSION_PAYLOAD_INVALID: parse.warnings and parse.blocking_issues must be arrays'
      using errcode = 'P0001';
  end if;

  -- Serializes two uploads racing on the same submission, so the row the items
  -- are attached to is the row that was checked. The previous fingerprint is
  -- read under the same lock, so two concurrent replays cannot both decide they
  -- are the first.
  select s.status, s.parse_fingerprint, s.processing_token
    into v_status, v_previous, v_held
  from public.order_submissions s
  where s.id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  -- NO REPLACEMENT OUTSIDE THE LEASE.
  --
  -- The caller must present the token that currently holds this submission.
  -- That makes the whole three-step run — upload, replace, clean — the property
  -- of one processor, and it makes a late write from an abandoned attempt
  -- impossible: taking over a stale lease changes the token, so the old
  -- processor's replacement is refused rather than landing on top of the new
  -- one's work.
  if v_held is null or v_token is null or v_held <> v_token then
    raise exception
      'ORDER_SUBMISSION_PROCESSING_NOT_HELD: this parse replacement does not hold the processing lease'
      using errcode = '55P03';
  end if;

  -- Re-derives everything about p_actor_id from the database: active, holds
  -- orders.create, owns THIS submission, and the submission is still editable.
  perform public.assert_order_submission_editor(p_submission_id, p_actor_id);

  -- A replay of the payload already stored. The write below still runs and is a
  -- no-op; what is suppressed is the audit entry, because nothing happened.
  v_unchanged := v_fingerprint is not null and v_previous is not null and v_fingerprint = v_previous;

  update public.order_submissions set
    parse_fingerprint       = v_fingerprint,
    client_name             = nullif(btrim(coalesce(v_header ->> 'client_name', '')), ''),
    creation_date           = nullif(v_header ->> 'creation_date', '')::date,
    source_created_by       = nullif(btrim(coalesce(v_header ->> 'source_created_by', '')), ''),
    boe_gst                 = nullif(btrim(coalesce(v_header ->> 'boe_gst', '')), ''),
    contact_number          = nullif(btrim(coalesce(v_header ->> 'contact_number', '')), ''),
    bill_to_name            = nullif(btrim(coalesce(v_header ->> 'bill_to_name', '')), ''),
    bill_to_phone           = nullif(btrim(coalesce(v_header ->> 'bill_to_phone', '')), ''),
    bill_to_gst             = nullif(btrim(coalesce(v_header ->> 'bill_to_gst', '')), ''),
    billing_address         = nullif(btrim(coalesce(v_header ->> 'billing_address', '')), ''),
    ship_to_name            = nullif(btrim(coalesce(v_header ->> 'ship_to_name', '')), ''),
    ship_to_phone           = nullif(btrim(coalesce(v_header ->> 'ship_to_phone', '')), ''),
    ship_to_gst             = nullif(btrim(coalesce(v_header ->> 'ship_to_gst', '')), ''),
    shipping_address        = nullif(btrim(coalesce(v_header ->> 'shipping_address', '')), ''),
    order_confirmation_date = nullif(v_header ->> 'order_confirmation_date', '')::date,
    dispatch_commitment     = nullif(btrim(coalesce(v_header ->> 'dispatch_commitment', '')), ''),
    -- The dispatch DATE, when the document carried one. Decided entirely in
    -- src/lib/orders/dueDate.ts before the payload was built: this writes what
    -- it was given and never parses prose. A payload from an older build has no
    -- such key, and ->> yields NULL, which is the correct answer for it.
    due_date                = nullif(v_header ->> 'due_date', '')::date,
    source_order_number     = nullif(btrim(coalesce(v_header ->> 'source_order_number', '')), ''),

    source_workbook_path       = nullif(btrim(coalesce(v_source ->> 'workbook_path', '')), ''),
    source_workbook_name       = nullif(btrim(coalesce(v_source ->> 'workbook_name', '')), ''),
    source_workbook_size_bytes = nullif(v_source ->> 'workbook_size_bytes', '')::bigint,
    source_workbook_sha256     = nullif(btrim(lower(coalesce(v_source ->> 'workbook_sha256', ''))), ''),
    template_version           = nullif(btrim(coalesce(v_source ->> 'template_version', '')), ''),

    parse_warnings        = v_warnings,
    parse_blocking_issues = v_blocking,

    gross_product_amount    = coalesce(nullif(v_commercial ->> 'gross_product_amount', '')::numeric, 0),
    discount_amount         = coalesce(nullif(v_commercial ->> 'discount_amount', '')::numeric, 0),
    subtotal_after_discount = nullif(v_commercial ->> 'subtotal_after_discount', '')::numeric,

    -- The two cost cells: amount AND meaning AND wording, together, so the
    -- table constraint can prove they agree. A payload that omits the meaning
    -- falls back to 'numeric', which is what a plain figure is.
    fabric_cost             = nullif(v_commercial ->> 'fabric_cost', '')::numeric,
    fabric_cost_meaning     = coalesce(nullif(btrim(coalesce(v_commercial ->> 'fabric_cost_meaning', '')), ''), 'numeric'),
    fabric_cost_text        = nullif(btrim(coalesce(v_commercial ->> 'fabric_cost_text', '')), ''),
    packing_cost            = nullif(v_commercial ->> 'packing_cost', '')::numeric,
    packing_cost_meaning    = coalesce(nullif(btrim(coalesce(v_commercial ->> 'packing_cost_meaning', '')), ''), 'numeric'),
    packing_cost_text       = nullif(btrim(coalesce(v_commercial ->> 'packing_cost_text', '')), ''),

    transportation_amount   = nullif(v_commercial ->> 'transportation_amount', '')::numeric,
    transportation_text     = nullif(btrim(coalesce(v_commercial ->> 'transportation_text', '')), ''),
    total_before_gst        = nullif(v_commercial ->> 'total_before_gst', '')::numeric,
    gst_amount              = nullif(v_commercial ->> 'gst_amount', '')::numeric,
    grand_total             = nullif(v_commercial ->> 'grand_total', '')::numeric
  where id = p_submission_id;

  -- Atomic replacement. Deleting the items cascades their image rows away, so
  -- an obsolete picture from a previous upload cannot survive into the new
  -- reading of the document.
  delete from public.order_submission_items where submission_id = p_submission_id;

  insert into public.order_submission_items (
    id, submission_id, source_row, item_sequence, source_product_code, product_name,
    quantity, dimensions, material, customization, cost_per_piece, total_amount,
    image_storage_path, image_mime_type, image_sha256, image_anchor_row, sort_order
  )
  select
    -- The CLIENT may supply the item id, and now always does: the image keys
    -- contain it and the objects are uploaded BEFORE this function runs.
    coalesce(nullif(item ->> 'id', '')::uuid, gen_random_uuid()),
    p_submission_id,
    (item ->> 'source_row')::integer,
    nullif(btrim(coalesce(item ->> 'item_sequence', '')), ''),
    nullif(btrim(coalesce(item ->> 'source_product_code', '')), ''),
    nullif(btrim(coalesce(item ->> 'product_name', '')), ''),
    (item ->> 'quantity')::numeric,
    nullif(btrim(coalesce(item ->> 'dimensions', '')), ''),
    -- Separate columns, deliberately. Never merged.
    nullif(btrim(coalesce(item ->> 'material', '')), ''),
    nullif(btrim(coalesce(item ->> 'customization', '')), ''),
    (item ->> 'cost_per_piece')::numeric,
    (item ->> 'total_amount')::numeric,
    -- Legacy compatibility fields, written from the representative image.
    nullif(btrim(coalesce(item ->> 'image_storage_path', '')), ''),
    nullif(btrim(coalesce(item ->> 'image_mime_type', '')), ''),
    nullif(btrim(lower(coalesce(item ->> 'image_sha256', ''))), ''),
    nullif(item ->> 'image_anchor_row', '')::integer,
    coalesce(nullif(item ->> 'sort_order', '')::integer, (ordinality - 1)::integer)
  from jsonb_array_elements(v_items) with ordinality as t(item, ordinality);

  -- Every image must name an item of THIS submission. The composite foreign key
  -- below would refuse a foreign one anyway; this check exists so the failure
  -- is a named business error rather than a constraint violation, and so the
  -- count of them can be reported.
  select count(*) into v_foreign
  from jsonb_array_elements(v_images) as img
  where not exists (
    select 1 from public.order_submission_items i
    where i.id = nullif(img.value ->> 'item_id', '')::uuid
      and i.submission_id = p_submission_id
  );

  if v_foreign > 0 then
    raise exception
      'ORDER_SUBMISSION_IMAGE_ITEM_UNKNOWN: % image(s) name a product line that does not belong to this submission',
      v_foreign
      using errcode = 'P0001';
  end if;

  insert into public.order_submission_item_images (
    submission_id, item_id, role, position,
    storage_path, mime_type, sha256, source_media_path, anchor_row
  )
  select
    p_submission_id,
    (img ->> 'item_id')::uuid,
    img ->> 'role',
    (img ->> 'position')::integer,
    btrim(img ->> 'storage_path'),
    btrim(img ->> 'mime_type'),
    lower(btrim(img ->> 'sha256')),
    nullif(btrim(coalesce(img ->> 'source_media_path', '')), ''),
    (img ->> 'anchor_row')::integer
  from jsonb_array_elements(v_images) as t(img);

  select count(*) into v_count
  from public.order_submission_items where submission_id = p_submission_id;

  select
    count(*) filter (where role = 'representative'),
    count(*) filter (where role = 'customization')
  into v_rep_count, v_cust_count
  from public.order_submission_item_images where submission_id = p_submission_id;

  -- NO ENTRY FOR A REPLAY. Pressing Retry after a network timeout is not three
  -- submissions, and an append-only trail that said so would be a false record
  -- of what an employee did. A genuine re-parse — a corrected workbook, a
  -- different file — has a different fingerprint and is logged normally.
  if not v_unchanged then
    perform public.log_order_submission_activity(
      p_submission_id, p_actor_id, 'parse_replaced', v_status, v_status, null,
      jsonb_build_object(
        'item_count',                 v_count,
        'representative_image_count', v_rep_count,
        'customization_image_count',  v_cust_count,
        'warning_count',              jsonb_array_length(v_warnings),
        'blocking_issue_count',       jsonb_array_length(v_blocking)
      )
    );
  end if;

  return jsonb_build_object(
    'id', p_submission_id,
    'status', v_status,
    'item_count', v_count,
    'representative_image_count', v_rep_count,
    'customization_image_count', v_cust_count,
    'blocking_issue_count', jsonb_array_length(v_blocking),
    'unchanged', v_unchanged
  );
end;
$$;

-- ── 5. The due date follows the record onto the Order ─────────────────────────
--
-- WHY THIS IS HERE. public.orders has carried a `due_date date` since 20260655,
-- and approve_order_submission() has always left it NULL. 20260915000000 said
-- why, at length, and was right at the time: "dispatch_commitment is free TEXT
-- — '30 days', 'mid-October' — and orders.due_date is a DATE. There is no safe
-- conversion, and a made-up delivery date is worse than none."
--
-- That reasoning is untouched. What changed is that there is now a second
-- source, and it is not free text: order_submissions.due_date, written only
-- from an explicit, plausible calendar date by the rule in section 2 above and
-- in src/lib/orders/dueDate.ts. So the Order takes THAT, and dispatch_commitment
-- is still never read here, still never parsed, and still never converted.
--
-- IT IS A COPY, NOT A DERIVATION. The value was validated once, when it was
-- adopted. Re-checking it at approval would be a second rule that could
-- disagree with the first, and would overrule a due date a human had corrected.
-- NULL stays NULL: a submission with no due date makes an Order with no due
-- date, exactly as today.
--
-- EVERYTHING ELSE IS VERBATIM. The function below is 20260921000000's, re-emitted
-- unchanged apart from the two lines marked at the INSERT — the same signature,
-- the same `returns jsonb`, the same `security definer`, the same
-- `set search_path = public, pg_temp`, the same actor assertion, the same
-- verified-payment gate, the same numbering, the same row locks and the same
-- allocation move. src/lib/orders/dueDateContinuity.test.ts proves that by
-- diffing this text against the applied migration's.

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
    created_by, status, source_order_submission_id
  )
  values (
    v_client,
    v_sub.submitted_by,
    coalesce(v_sub.order_confirmation_date, v_now::date),
    v_sub.due_date,
    v_sub.grand_total,
    v_sub.gross_product_amount,
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
-- environment which somehow lost them is repaired by re-running this migration,
-- and so the intended grant is visible beside the function rather than only in
-- a migration two files back.
revoke all on function public.approve_order_submission(uuid) from public;
grant execute on function public.approve_order_submission(uuid) to authenticated;

-- ── 6. What was deliberately NOT done ─────────────────────────────────────────
--
-- No CHECK constraint ties due_date to order_confirmation_date. The rule above
-- governs what this migration and the parser may ADOPT from a document; it must
-- not govern what a human may later enter. When due dates become editable at
-- order confirmation, somebody correcting a date to a day before the recorded
-- confirmation is a data correction, not a violation, and a constraint would
-- turn it into an error report.
--
-- dispatch_commitment is not cleared for adopted rows. It is the source record
-- of what the document said, and the screen no longer shows it as a date.

commit;
