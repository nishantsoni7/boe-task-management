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
-- ── 5. What was deliberately NOT done ─────────────────────────────────────────
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
