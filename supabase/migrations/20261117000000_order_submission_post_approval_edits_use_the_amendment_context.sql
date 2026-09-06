-- ═══════════════════════════════════════════════════════════════════════════
-- The two post-approval PI edits speak to the Order through the amendment door
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE DEFECT. Once a PI is approved and its Confirmed Order exists, two
-- admin paths carry the corrected figures onto that Order:
--
--   * replace_order_submission_parse()        — "Change PI" after approval
--   * update_order_submission_client_details() — correcting the client's name
--
-- Both write columns that orders_guard_amendable_columns() freezes, and both
-- write them OUTSIDE in_order_amendment(). The guard therefore refuses:
--
--   ORDER_AMENDMENT_REQUIRED: The terms of Order NNNN can only be changed
--   through an order amendment, which records who changed what and why
--
-- Reproduced against the live guard on a disposable database: the exact
-- statements these two functions run are refused, while the same statements
-- inside in_order_amendment() succeed. Only the CALLERS are wrong; the guard
-- is right and is not touched here.
--
-- WHY IT HAS NOT BITTEN YET. Both paths need order_id to be set, which happens
-- only once a PI becomes a Confirmed Order. Production holds no Confirmed
-- Orders today, so neither path has been reachable. The Order + Finance
-- workflow makes them reachable the moment the first Order is confirmed, which
-- is why this is fixed before that happens rather than after.
--
-- THE FIX. Each function now opens the EXISTING transaction-local amendment
-- context immediately before its own authorised UPDATE of public.orders and
-- closes it immediately after — the same door amend_order() has used since
-- 20260816000000, and the same one approve_order_pi_revision() uses for the
-- revised-PI path. Nothing else in either body changes.
--
-- WHAT IS NOT DONE HERE. The guard is not weakened, no column leaves its
-- frozen list, no exemption is widened, no grant changes, no permission
-- changes, and neither function is redesigned. The window is exactly one
-- statement wide in each function: everything before and after it still meets
-- the guard unaided.
--
-- ADDITIVE. Two function bodies re-emitted. No table, column, policy, trigger,
-- index or grant is touched, and no row is rewritten.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.replace_order_submission_parse(uuid, uuid, jsonb)') is null then
    raise exception 'DEPENDENCY MISSING: 20261003000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.update_order_submission_client_details(uuid, jsonb, integer, text)') is null then
    raise exception 'DEPENDENCY MISSING: 20260928000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.in_order_amendment()') is null then
    raise exception 'DEPENDENCY MISSING: 20260816000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.orders_guard_amendable_columns()') is null then
    raise exception 'DEPENDENCY MISSING: the Order column guard must exist before this migration';
  end if;
end $$;


-- ─── A. replace_order_submission_parse, as 20261003000000 left it ───────────
--     plus the amendment context around its own Order UPDATE.

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
  -- What the workbook editor decided: whether this is an admin amendment after
  -- submission, and the reason it required.
  v_amend       jsonb;
  v_after       boolean;
  v_reason      text;
  v_order       uuid;
  v_superseded  integer := 0;
  v_cleared     boolean := false;
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
  -- THE ONLY AUTHORITY CHANGE. assert_order_submission_editor checks the STAGE
  -- before the actor, so an active admin can never replace a workbook on a PI
  -- that has left draft — the same structural bug can_edit_order_submission
  -- carried for the billing percentage. The workbook editor puts the actor
  -- first and takes a reason for an amendment.
  v_amend := public.assert_order_submission_workbook_editor(
    p_submission_id, p_actor_id,
    nullif(btrim(coalesce(p_payload ->> 'change_reason', '')), ''));

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

  -- ═══ WHAT A REPLACEMENT MEANS ONCE THE PI HAS LEFT DRAFT ═══════════════
  --
  -- Everything below is skipped entirely for the ordinary case — an owner
  -- re-uploading their own draft — because none of it applies there. It runs
  -- only when the PI has been submitted or already has an Order.
  v_after  := coalesce((v_amend ->> 'after_submission')::boolean, false);
  v_reason := v_amend ->> 'reason';

  if v_after and not v_unchanged then
    select order_id into v_order from public.order_submissions where id = p_submission_id;

    -- ── Finance verification cannot survive a new commercial basis ──
    --
    -- The clearing trigger from 20260915000000 fires on a STATUS CHANGE, and a
    -- workbook replacement is not one: a submitted PI stays submitted. So a
    -- sign-off made against the previous figures would otherwise stand against
    -- the new ones. Cleared here, for the same reason the trigger clears it
    -- anywhere else — whatever finance signed off is no longer the thing under
    -- review.
    --
    -- The reduced-payment exception needs no equivalent, and deliberately so:
    -- order_submission_exception_current() DERIVES currency by comparing the
    -- recorded basis against the live grand total, workbook hash and both
    -- terms. Replacing the workbook moves every one of them, so the decision
    -- stops being current on its own. Storing a second answer would be a second
    -- thing to keep in step.
    update public.order_submissions
       set finance_verified_by            = null,
           finance_verified_at            = null,
           finance_verified_submission_at = null
     where id = p_submission_id
       and finance_verified_at is not null;
    v_cleared := found;

    if v_order is not null then
      -- ── The Order carries the corrected figures ──
      --
      -- Its IDENTITY does not move: not the id, not the confirmed number, not
      -- the PI linkage, not one payment and not one allocation. Only the
      -- mirrored values follow their source.
      perform set_config('boe.amendment_context', 'order_amendment', true);

      update public.orders o
         set client_name         = coalesce(s.client_name, o.client_name),
             confirm_date        = coalesce(s.order_confirmation_date, o.confirm_date),
             due_date            = s.due_date,
             total_value         = s.grand_total,
             total_product_value = s.gross_product_amount,
             billing_percentage  = s.billing_percentage,
             updated_at          = now()
        from public.order_submissions s
       where o.id = v_order and s.id = p_submission_id;

      perform set_config('boe.amendment_context', '', true);


      -- Every figure on both documents came from the file that was just
      -- replaced, so the ready pair is stale in full.
      v_superseded := public.supersede_order_documents(v_order, 'pi_data_amended');

      insert into public.order_activity_log (order_id, actor_id, event_type, payload)
      values (v_order, p_actor_id, 'order_workbook_replaced',
              jsonb_build_object('submission_id', p_submission_id,
                                 'reason', v_reason,
                                 'after_approval', true,
                                 'superseded_documents', v_superseded));
    end if;

    perform public.log_order_submission_activity(
      p_submission_id, p_actor_id, 'workbook_replaced_by_admin',
      v_status, v_status, v_reason,
      jsonb_build_object('after_submission', true,
                         'finance_verification_cleared', v_cleared,
                         'order_id', v_order,
                         'superseded_documents', v_superseded,
                         'item_count', v_count)
    );
  end if;

  return jsonb_build_object(
    'id', p_submission_id,
    'status', v_status,
    'after_submission', coalesce(v_after, false),
    'finance_verification_cleared', v_cleared,
    'superseded_documents', v_superseded,
    'item_count', v_count,
    'representative_image_count', v_rep_count,
    'customization_image_count', v_cust_count,
    'blocking_issue_count', jsonb_array_length(v_blocking),
    'unchanged', v_unchanged
  );
end;
$$;
revoke execute on function public.replace_order_submission_parse(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant  execute on function public.replace_order_submission_parse(uuid, uuid, jsonb)
  to service_role;

comment on function public.replace_order_submission_parse(uuid, uuid, jsonb) is
  'SERVICE ROLE ONLY. Writes the parsed commercial snapshot, every product line and every normalized product image of a PI submission. Not callable by anon or authenticated, because these values must come from parsing the uploaded workbook server-side and never from a browser. p_actor_id is re-validated against the database, not trusted. Since 20261003000000 an ACTIVE ADMIN may also run it after submission, with a reason in payload.change_reason: that clears any finance verification, carries the corrected figures onto the linked Order without touching its identity, and supersedes the current confirmed documents. Since 20261117000000 that one Order UPDATE runs inside the amendment context, which is what orders_guard_amendable_columns() requires of every writer of those columns.';


-- ─── B. update_order_submission_client_details, as 20260928000000 left it ───
--     plus the amendment context around its own Order UPDATE.

create or replace function public.update_order_submission_client_details(
  p_submission_id    uuid,
  p_fields           jsonb,
  p_expected_version integer default null,
  p_reason           text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := auth.uid();
  v_sub        public.order_submissions%rowtype;
  v_is_admin   boolean;
  v_is_owner   boolean;
  v_after_sub  boolean;
  v_reason     text;
  v_key        text;
  v_new        text;
  v_old        text;
  v_changes    jsonb := '{}'::jsonb;
  v_changed    integer := 0;
  v_superseded integer := 0;
  v_version    integer;
  v_client_changed boolean := false;

  -- THE ALLOW-LIST. Every editable field of this section, and nothing else.
  -- A key not on this list is refused, not skipped: silently dropping an
  -- unrecognised field would let a caller believe it saved something it did not.
  c_fields constant text[] := array[
    'client_name', 'contact_number',
    'bill_to_name', 'bill_to_phone', 'bill_to_gst', 'billing_address',
    'ship_to_name', 'ship_to_phone', 'ship_to_gst', 'shipping_address'
  ];

  -- Fields that appear on the confirmed documents. A change to one of these
  -- makes an existing ready pair no longer current; a change to the others
  -- does not, and superseding for them would make people regenerate for nothing.
  c_printed constant text[] := array[
    'client_name', 'bill_to_name', 'billing_address',
    'ship_to_name', 'shipping_address'
  ];
begin
  if v_actor is null then
    raise exception 'ORDER_SUBMISSION_NOT_AUTHENTICATED: you must be signed in'
      using errcode = '42501';
  end if;

  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'ORDER_SUBMISSION_BAD_FIELDS: a JSON object of fields is required'
      using errcode = 'P0001';
  end if;

  -- THE ROW LOCK COMES FIRST, before any judgement of state, authority or
  -- staleness, so the state every check reads is the state the write lands on.
  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'ORDER_SUBMISSION_NOT_FOUND: submission % not found', p_submission_id
      using errcode = 'P0002';
  end if;

  -- ── Authority ──
  v_is_admin := public.can_admin_edit_order_submission(p_submission_id);
  v_is_owner := public.can_edit_order_submission(p_submission_id);

  if not (v_is_admin or v_is_owner) then
    raise exception
      'ORDER_SUBMISSION_NOT_EDITABLE: this PI cannot be changed by you in its current state'
      using errcode = '42501';
  end if;

  -- ── Optimistic concurrency ──
  --
  -- Checked AFTER the lock and BEFORE any change is computed. Two admins with
  -- the dialog open must not silently overwrite one another; the second is told
  -- to re-read.
  if p_expected_version is not null
     and v_sub.row_version is distinct from p_expected_version then
    raise exception
      'ORDER_SUBMISSION_STALE: this PI changed while you were editing it. Reopen it and apply your change again.'
      using errcode = 'P0001';
  end if;

  -- ── The reason, for an amendment ──
  v_after_sub := v_sub.status not in ('draft', 'needs_changes') or v_sub.order_id is not null;

  if v_after_sub and not v_is_owner then
    v_reason := nullif(btrim(coalesce(p_reason, '')), '');
    if v_reason is null then
      raise exception
        'ORDER_SUBMISSION_REASON_REQUIRED: editing a submitted PI needs a reason'
        using errcode = 'P0001';
    end if;
    if length(v_reason) > 500 then
      raise exception
        'ORDER_SUBMISSION_REASON_TOO_LONG: the reason may be at most 500 characters'
        using errcode = 'P0001';
    end if;
  else
    v_reason := null;
  end if;

  -- ── Every key must be one this function owns ──
  for v_key in select jsonb_object_keys(p_fields) loop
    if not (v_key = any (c_fields)) then
      raise exception
        'ORDER_SUBMISSION_UNKNOWN_FIELD: % is not an editable client detail', v_key
        using errcode = 'P0001';
    end if;
    if jsonb_typeof(p_fields -> v_key) not in ('string', 'null') then
      raise exception
        'ORDER_SUBMISSION_BAD_FIELD_TYPE: % must be text or null', v_key
        using errcode = 'P0001';
    end if;
  end loop;

  -- ── Compute the change set ──
  --
  -- Blank becomes NULL, matching replace_order_submission_parse exactly, so a
  -- field cleared by hand and a field the parser never found are the same
  -- state. Anything else would make "empty" mean two different things.
  for v_key in select unnest(c_fields) loop
    continue when not (p_fields ? v_key);

    v_new := nullif(btrim(coalesce(p_fields ->> v_key, '')), '');

    if v_new is not null and length(v_new) > 500 then
      raise exception
        'ORDER_SUBMISSION_FIELD_TOO_LONG: % may be at most 500 characters', v_key
        using errcode = 'P0001';
    end if;

    execute format('select ($1).%I::text', v_key) into v_old using v_sub;

    if v_new is distinct from v_old then
      v_changed := v_changed + 1;
      v_changes := v_changes || jsonb_build_object(
        v_key, jsonb_build_object('from', v_old, 'to', v_new));
      if v_key = 'client_name' then v_client_changed := true; end if;
    end if;
  end loop;

  -- ── A reviewable PI must keep its client name ──
  --
  -- order_submissions_reviewable_is_complete already forbids this, but a CHECK
  -- violation reaches the caller as a constraint name. Saying it here means the
  -- reader is told what is wrong instead of being handed a catalog identifier.
  if v_changes ? 'client_name'
     and (v_changes -> 'client_name' ->> 'to') is null
     and v_sub.status not in ('draft', 'needs_changes') then
    raise exception
      'ORDER_SUBMISSION_CLIENT_NAME_REQUIRED: a PI that has been submitted must keep a client name'
      using errcode = 'P0001';
  end if;

  -- NOTHING CHANGED: no write, no event, no supersession. The same rule the
  -- billing percentage follows, for the same reason — a save that changed
  -- nothing is not an amendment and must not read like one in the trail.
  if v_changed = 0 then
    return jsonb_build_object(
      'submission_id', p_submission_id,
      'changed',       false,
      'fields',        0,
      'row_version',   v_sub.row_version,
      'superseded_documents', 0
    );
  end if;

  -- ── The write ──
  --
  -- Each column takes its new value only when the caller SENT that key, so a
  -- partial object edits exactly what it names and leaves the rest alone. An
  -- absent key is not the same as a null one, and this is where that holds.
  update public.order_submissions set
    client_name      = case when p_fields ? 'client_name'      then nullif(btrim(coalesce(p_fields ->> 'client_name', '')), '')      else client_name      end,
    contact_number   = case when p_fields ? 'contact_number'   then nullif(btrim(coalesce(p_fields ->> 'contact_number', '')), '')   else contact_number   end,
    bill_to_name     = case when p_fields ? 'bill_to_name'     then nullif(btrim(coalesce(p_fields ->> 'bill_to_name', '')), '')     else bill_to_name     end,
    bill_to_phone    = case when p_fields ? 'bill_to_phone'    then nullif(btrim(coalesce(p_fields ->> 'bill_to_phone', '')), '')    else bill_to_phone    end,
    bill_to_gst      = case when p_fields ? 'bill_to_gst'      then nullif(btrim(coalesce(p_fields ->> 'bill_to_gst', '')), '')      else bill_to_gst      end,
    billing_address  = case when p_fields ? 'billing_address'  then nullif(btrim(coalesce(p_fields ->> 'billing_address', '')), '')  else billing_address  end,
    ship_to_name     = case when p_fields ? 'ship_to_name'     then nullif(btrim(coalesce(p_fields ->> 'ship_to_name', '')), '')     else ship_to_name     end,
    ship_to_phone    = case when p_fields ? 'ship_to_phone'    then nullif(btrim(coalesce(p_fields ->> 'ship_to_phone', '')), '')    else ship_to_phone    end,
    ship_to_gst      = case when p_fields ? 'ship_to_gst'      then nullif(btrim(coalesce(p_fields ->> 'ship_to_gst', '')), '')      else ship_to_gst      end,
    shipping_address = case when p_fields ? 'shipping_address' then nullif(btrim(coalesce(p_fields ->> 'shipping_address', '')), '') else shipping_address end,
    row_version      = row_version + 1,
    updated_at       = now()
  where id = p_submission_id
  returning row_version into v_version;

  -- ── The linked Order carries the client's name ──
  --
  -- orders.client_name is written at approval from the PI's value. Leaving it
  -- behind would make the Order state a name its own PI no longer says.
  -- NOTHING ELSE on the Order is touched: not the number, not the link, not a
  -- total, not an allocation, not a payment.
  if v_sub.order_id is not null and v_client_changed then
    perform set_config('boe.amendment_context', 'order_amendment', true);

    update public.orders
       set client_name = (v_changes -> 'client_name' ->> 'to'),
           updated_at  = now()
     where id = v_sub.order_id;

    perform set_config('boe.amendment_context', '', true);

  end if;

  -- ── Ready documents stop being current ──
  if v_sub.order_id is not null
     and exists (select 1 from unnest(c_printed) k where v_changes ? k) then
    v_superseded := public.supersede_order_documents(v_sub.order_id, 'pi_data_amended');
  end if;

  if v_sub.order_id is not null then
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (
      v_sub.order_id, v_actor, 'order_client_details_amended',
      jsonb_build_object(
        'fields',   v_changed,
        'changed',  v_changes,
        'by_admin', v_is_admin and not v_is_owner,
        'reason',   v_reason
      )
    );
  end if;

  -- ── The PI's own trail ──
  --
  -- BEFORE AND AFTER, per field, so the record answers "what did it say
  -- before" without anyone having to reconstruct it. Owner and admin edits are
  -- different actions, not one action with a flag.
  --
  -- These are business text fields — names, phones, addresses, tax numbers.
  -- No image bytes and no secret can reach here: the allow-list above admits
  -- ten named text columns and refuses everything else.
  perform public.log_order_submission_activity(
    p_submission_id,
    v_actor,
    case when v_after_sub and not v_is_owner
         then 'client_details_amended_by_admin'
         else 'client_details_updated' end,
    v_sub.status,
    v_sub.status,
    v_reason,
    jsonb_build_object(
      'fields',                v_changed,
      'changed',               v_changes,
      'stage',                 v_sub.status,
      'after_submission',      v_after_sub,
      'superseded_documents',  v_superseded
    )
  );

  return jsonb_build_object(
    'submission_id',        p_submission_id,
    'changed',              true,
    'fields',               v_changed,
    'row_version',          v_version,
    'superseded_documents', v_superseded
  );
end;
$$;
comment on function public.update_order_submission_client_details(uuid, jsonb, integer, text) is
  'Edits a PI''s client and party details — the ten named text fields and nothing else. The OWNER may do so in draft/needs_changes; an ACTIVE ADMIN at any stage, with a reason once the PI has been submitted. Optimistic concurrency through p_expected_version, a monotonic counter rather than a timestamp. Touches no derived value, no status, no payment and no document file. A change to a printed field supersedes the linked Order''s ready documents. Since 20261117000000 the one Order UPDATE that carries the client''s name across runs inside the amendment context, which is what orders_guard_amendable_columns() requires.';

revoke all    on function public.update_order_submission_client_details(uuid, jsonb, integer, text) from public, anon;
grant  execute on function public.update_order_submission_client_details(uuid, jsonb, integer, text) to authenticated;


-- ─── Assertions ─────────────────────────────────────────────────────────────

do $$
declare
  v_a     text := pg_get_functiondef('public.replace_order_submission_parse(uuid, uuid, jsonb)'::regprocedure);
  v_b     text := pg_get_functiondef('public.update_order_submission_client_details(uuid, jsonb, integer, text)'::regprocedure);
  v_guard text := pg_get_functiondef('public.orders_guard_amendable_columns()'::regprocedure);
  v_n     integer;
begin
  -- Each function opens and closes the context exactly once.
  if (select count(*) from regexp_matches(v_a, 'set_config\(''boe\.amendment_context''', 'g')) <> 2 then
    raise exception 'ASSERTION FAILED: replace_order_submission_parse must open and close the amendment context exactly once';
  end if;
  if (select count(*) from regexp_matches(v_b, 'set_config\(''boe\.amendment_context''', 'g')) <> 2 then
    raise exception 'ASSERTION FAILED: update_order_submission_client_details must open and close the amendment context exactly once';
  end if;

  -- The context must BRACKET the Order UPDATE, not merely appear.
  if position('set_config(''boe.amendment_context'', ''order_amendment'', true)' in v_a)
     > position('update public.orders' in v_a) then
    raise exception 'ASSERTION FAILED: A opens the context after the statement it must cover';
  end if;
  if position('set_config(''boe.amendment_context'', ''order_amendment'', true)' in v_b)
     > position('update public.orders' in v_b) then
    raise exception 'ASSERTION FAILED: B opens the context after the statement it must cover';
  end if;

  -- Each function still writes public.orders exactly once. A second, unguarded
  -- Order write would sit outside the window this migration opened.
  if (select count(*) from regexp_matches(v_a, 'update public\.orders', 'g')) <> 1 then
    raise exception 'ASSERTION FAILED: replace_order_submission_parse writes public.orders more than once';
  end if;
  if (select count(*) from regexp_matches(v_b, 'update public\.orders', 'g')) <> 1 then
    raise exception 'ASSERTION FAILED: update_order_submission_client_details writes public.orders more than once';
  end if;

  -- THE GUARD IS UNTOUCHED. Every column it froze, it still freezes.
  select count(*) into v_n from regexp_matches(v_guard, 'new\.[a-z_]+\s+is distinct from', 'g');
  if v_n < 12 then
    raise exception 'ASSERTION FAILED: the Order column guard refuses only % column(s)', v_n;
  end if;
  if v_guard not like '%ORDER_AMENDMENT_REQUIRED%'
     or v_guard not like '%in_order_amendment()%'
     or v_guard not like '%ORDER_PRODUCTION_ALIGNMENT_PATH_REQUIRED%' then
    raise exception 'ASSERTION FAILED: the Order column guard lost a rule it had';
  end if;

  -- Authorization and actor derivation are unchanged in both.
  if v_a not like '%assert_order_submission_workbook_editor%' then
    raise exception 'ASSERTION FAILED: replace_order_submission_parse lost its editor check';
  end if;
  if v_b not like '%auth.uid()%' then
    raise exception 'ASSERTION FAILED: update_order_submission_client_details no longer derives its actor server-side';
  end if;

  -- The service-role-only door stays shut to client roles.
  if has_function_privilege('authenticated', 'public.replace_order_submission_parse(uuid, uuid, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.replace_order_submission_parse(uuid, uuid, jsonb)', 'execute') then
    raise exception 'ASSERTION FAILED: a client role can call replace_order_submission_parse';
  end if;
  if not has_function_privilege('service_role', 'public.replace_order_submission_parse(uuid, uuid, jsonb)', 'execute') then
    raise exception 'ASSERTION FAILED: service_role cannot call replace_order_submission_parse';
  end if;
  if not has_function_privilege('authenticated', 'public.update_order_submission_client_details(uuid, jsonb, integer, text)', 'execute') then
    raise exception 'ASSERTION FAILED: authenticated cannot call update_order_submission_client_details';
  end if;
  if has_function_privilege('anon', 'public.update_order_submission_client_details(uuid, jsonb, integer, text)', 'execute') then
    raise exception 'ASSERTION FAILED: anon can call update_order_submission_client_details';
  end if;

  raise notice '20261117000000 applied: the two post-approval PI edits now amend the Order through the amendment context.';
end $$;
