-- ═══════════════════════════════════════════════════════════════════════════
-- CHANGE PI — replacing the workbook, and what that means at each stage
--
-- ── WHY THIS EXISTS ───────────────────────────────────────────────────────
--
-- Everything a PI says about MONEY comes out of the workbook: quantity, rate,
-- discount, fabric, packing, transport, GST, grand total. Those figures are the
-- output of formulas that live in the spreadsheet and have never been read by
-- this system — the parser transcribes the results and raises a warning when
-- its own two derivations disagree. So there is exactly one honest way to
-- correct a commercial value: correct the workbook and import it again.
--
-- That path already exists. `replace_order_submission_parse` has done it since
-- 20260909000000 and was last re-emitted by 20260922000000. What it could not
-- do is run after the PI left draft, for anybody — including an administrator
-- correcting a genuine error on an approved Order.
--
-- ── THE BUG, WHICH IS THE ONE 20260927000000 ALREADY FOUND ────────────────
--
-- assert_order_submission_editor (20260908000000) judges STAGE BEFORE ACTOR:
--
--     if v_sub.status not in ('draft','needs_changes') or v_sub.order_id is not null
--       then raise ORDER_SUBMISSION_NOT_EDITABLE;      -- ← everybody, always
--     if not (owner or admin) then raise NOT_OWNED;    -- ← never reached
--
-- The admin branch is structurally unreachable, exactly as it was in
-- can_edit_order_submission for the billing percentage. This migration does the
-- same thing that one did: it adds a SECOND predicate beside the first rather
-- than widening it. assert_order_submission_editor is untouched, so every one
-- of its other callers keeps precisely the rule it has today.
--
-- ── WHAT IS DELIBERATELY *NOT* HERE ───────────────────────────────────────
--
-- No invalidation of the reduced-advance exception. It needs none:
-- order_submission_exception_current() (20260921000000) DERIVES currency by
-- comparing the decision's recorded basis against the live grand total, the
-- live workbook sha256 and both live terms. Replacing the workbook moves every
-- one of those, so the decision stops being current by itself. Writing a second
-- answer would be a second thing to keep in step with the first.
--
-- No clearing of advance_declared_amount either — 20260917000000's trigger
-- already nulls it whenever grand_total is replaced without a new amount in the
-- same statement, which is exactly what a replacement is.
--
-- No merge of hand-edited header fields with the new workbook's. THE WORKBOOK
-- REMAINS THE SOURCE OF TRUTH: where it speaks, it wins, and where it is silent
-- the field becomes silent too. A value typed into `Edit PI Details` before a
-- Change PI is therefore replaced by the new file's reading of the same field.
-- That is the existing behaviour of this function and it is left alone on
-- purpose — "the workbook said nothing" and "the workbook said blank" are the
-- same payload, so a preserve-on-silence rule would keep stale values with no
-- way to clear them. The surface warns before confirming instead, and the
-- readiness list re-reports anything the new file left empty with an editor
-- attached to it.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.supersede_order_documents(uuid, text)') is null then
    raise exception
      'DEPENDENCY MISSING: 20260927000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.replace_order_submission_parse(uuid, uuid, jsonb)') is null then
    raise exception
      'DEPENDENCY MISSING: 20260922000000 must be applied before this migration';
  end if;
end $$;


-- ═══ 1. Who may replace a workbook, and when ═══════════════════════════════
--
-- WHY IT TAKES AN ACTOR ID RATHER THAN READING auth.uid(). The billing
-- amendment could delegate to can_admin_edit_order_submission() because it runs
-- as the signed-in user. This one cannot: replace_order_submission_parse is
-- called by the import worker holding a processing lease, under the service
-- role, where auth.uid() is NULL. The actor is carried explicitly, and admin
-- status is re-derived from THAT id — never from the connection.
--
-- RETURNS A DECISION, not a bare pass. The caller needs to know which of the
-- two cases it is in, because a draft re-upload must do none of the work an
-- amendment does.

create or replace function public.assert_order_submission_workbook_editor(
  p_submission_id uuid,
  p_actor_id      uuid,
  p_reason        text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_admin boolean;
  v_is_owner boolean;
  v_after    boolean;
  v_reason   text;
  v_sub      public.order_submissions%rowtype;
begin
  if p_actor_id is null then
    raise exception 'ORDER_SUBMISSION_ACTOR_REQUIRED: an acting employee is required'
      using errcode = '28000';
  end if;

  -- coalesced to false for the same reason assert_order_submission_editor
  -- coalesces: `not (NULL or false)` is NULL, an IF on NULL takes no branch,
  -- and both guards below would then pass in silence.
  select coalesce(u.role = 'admin', false) into v_is_admin
  from public.users u
  where u.id = p_actor_id
    and u.is_active
    and coalesce(u.is_deleted, false) = false;

  if not found then
    raise exception 'ORDER_SUBMISSION_ACTOR_INVALID: that account is not active'
      using errcode = '42501';
  end if;

  if not (coalesce(v_is_admin, false)
          or coalesce(public.resolve_permission(p_actor_id, 'orders', 'create'), false)) then
    raise exception 'ORDER_SUBMISSION_FORBIDDEN: that employee cannot create order submissions'
      using errcode = '42501';
  end if;

  -- NO LOCK TAKEN HERE, and that is not an omission: every caller holds
  -- `select ... for update` on this row already, taken before any judgement of
  -- state. Taking a second one would be noise; taking the FIRST one here would
  -- move the lock after the caller's own reads and break that ordering.
  select * into v_sub from public.order_submissions where id = p_submission_id;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  v_is_owner := (v_sub.created_by = p_actor_id or v_sub.submitted_by = p_actor_id);

  -- The same boundary the billing amendment draws, word for word: everything
  -- the owner rule does not cover is "after submission".
  v_after := v_sub.status not in ('draft', 'needs_changes') or v_sub.order_id is not null;

  if not v_after then
    -- ── THE UNCHANGED RULE ──
    -- A draft or a returned PI belongs to its owner; an admin may also act.
    -- Identical in effect to assert_order_submission_editor, so nothing about
    -- the ordinary import path moves.
    if not (v_is_owner or coalesce(v_is_admin, false)) then
      raise exception 'ORDER_SUBMISSION_NOT_OWNED: that employee does not own this submission'
        using errcode = '42501';
    end if;
    return jsonb_build_object(
      'after_submission', false, 'is_admin_amendment', false, 'reason', null,
      'status', v_sub.status, 'order_id', v_sub.order_id);
  end if;

  -- ── PAST DRAFT: ACTIVE ADMIN ONLY ──
  --
  -- Owning the PI is not enough and never becomes enough. Holding
  -- orders.approve_order is not enough. Being the finance verifier is not
  -- enough. Once a PI is under review its figures are what other people are
  -- deciding against, and the ONE role that may move them is the one that
  -- answers for the record afterwards.
  if not coalesce(v_is_admin, false) then
    raise exception
      'ORDER_SUBMISSION_NOT_EDITABLE: a submission can only be changed while it is a draft or has been returned (this one is %)',
      v_sub.status
      using errcode = '42501';
  end if;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception
      'ORDER_SUBMISSION_WORKBOOK_REASON_REQUIRED: replacing the PI of a submitted record needs a reason'
      using errcode = 'P0001';
  end if;
  if length(v_reason) > 500 then
    raise exception
      'ORDER_SUBMISSION_WORKBOOK_REASON_TOO_LONG: the reason may be at most 500 characters'
      using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'after_submission', true, 'is_admin_amendment', true, 'reason', v_reason,
    'status', v_sub.status, 'order_id', v_sub.order_id);
end;
$$;

comment on function public.assert_order_submission_workbook_editor(uuid, uuid, text) is
  'Decides whether p_actor_id may replace this PI''s workbook, and returns {after_submission, is_admin_amendment, reason, status, order_id}. Owner or admin while draft/needs_changes with no Order; ACTIVE ADMIN ONLY thereafter, with a mandatory reason of at most 500 characters. Re-derives admin status from p_actor_id, never from auth.uid(), because the import worker runs as the service role. Deliberately separate from assert_order_submission_editor, which keeps the owner-only rule for every other caller.';

revoke execute on function public.assert_order_submission_workbook_editor(uuid, uuid, text)
  from public, anon, authenticated, service_role;


-- ═══ 2. The replacement itself ═════════════════════════════════════════════
--
-- RE-EMITTED IN FULL from 20260922000000, which is the house rule for this
-- function: `create or replace` cannot change a signature, every previous phase
-- has restated it whole, and a reader comparing two versions should be able to
-- see the entire thing rather than reconstruct it from patches.
--
-- IT DIFFERS FROM 20260922000000's VERSION IN EXACTLY TWO PLACES, and
-- changePiContinuity.test.ts holds the two texts together to prove there is no
-- third:
--
--   1. The authority line. `perform assert_order_submission_editor(...)`
--      becomes `v_amend := assert_order_submission_workbook_editor(...)`, which
--      reads the reason out of the payload.
--
--   2. A block appended after the activity entry, guarded by
--      `if v_after and not v_unchanged`, which is skipped entirely for the
--      ordinary draft re-upload.
--
-- Everything else — the lease check, the lock, the header write, the atomic
-- item replacement, the image checks, the fingerprint replay suppression — is
-- byte-for-byte what was already applied.
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

-- Restated so the privilege sits beside the definition rather than three
-- migrations back. Identical to 20260909000000's: service role only, because
-- the payload must come from parsing an uploaded workbook server-side.
revoke execute on function public.replace_order_submission_parse(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant  execute on function public.replace_order_submission_parse(uuid, uuid, jsonb)
  to service_role;

comment on function public.replace_order_submission_parse(uuid, uuid, jsonb) is
  'SERVICE ROLE ONLY. Writes the parsed commercial snapshot, every product line and every normalized product image of a PI submission. Not callable by anon or authenticated, because these values must come from parsing the uploaded workbook server-side and never from a browser. p_actor_id is re-validated against the database, not trusted. Since 20261003000000 an ACTIVE ADMIN may also run it after submission, with a reason in payload.change_reason: that clears any finance verification, carries the corrected figures onto the linked Order without touching its identity, and supersedes the current confirmed documents.';


-- ═══ 3. What this migration promises ═══════════════════════════════════════
do $$
declare
  v_src  text;
  v_prev text;
begin
  -- ── The fixed search_path, on both functions ──
  if (select count(*) from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('assert_order_submission_workbook_editor',
                          'replace_order_submission_parse')
        and 'search_path=public, pg_temp' = any(coalesce(p.proconfig, '{}'))) <> 2 then
    raise exception 'both functions must pin search_path = public, pg_temp';
  end if;

  -- ── Neither function may be reachable by a browser role ──
  if has_function_privilege('authenticated',
       'public.assert_order_submission_workbook_editor(uuid, uuid, text)', 'execute')
     or has_function_privilege('authenticated',
       'public.replace_order_submission_parse(uuid, uuid, jsonb)', 'execute') then
    raise exception 'a browser role can reach the workbook replacement path';
  end if;

  select pg_get_functiondef(p.oid) into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'replace_order_submission_parse';

  -- ── THE ORDER'S IDENTITY IS NEVER ASSIGNED ──
  --
  -- Read from the installed source rather than asserted in prose. The update of
  -- public.orders in section 2 may move mirrored values and nothing else: not
  -- the id, not the visible number, not the PI it came from, not its status.
  -- A future edit that added one of these would fail here rather than quietly
  -- rewrite an Order's identity behind an admin's correction.
  foreach v_prev in array array[
    'display_number', 'source_order_submission_id', 'status', 'created_by', 'requested_by'
  ] loop
    -- `set x = ...` on the first line of a SET list and a bare `x = ...` on the
    -- continuation lines are both assignments, so both forms are matched. A
    -- regex that only knew the second one let a mutation through in testing.
    if v_src ~ ('(?n)^\s*(set\s+)?' || v_prev || '\s*=') then
      raise exception 'replace_order_submission_parse assigns orders.% — identity must never move', v_prev;
    end if;
  end loop;

  -- ── It must not touch money that has already been recorded ──
  foreach v_prev in array array[
    'finance_payment_allocations', 'finance_payments', 'order_document_versions'
  ] loop
    if position(v_prev in v_src) > 0 then
      raise exception 'replace_order_submission_parse names % directly; payments and documents are moved only by their own functions', v_prev;
    end if;
  end loop;

  -- ── The two new actions must already be declared ──
  --
  -- 20261001000000 owns the closed action set. A replacement that logged an
  -- action the constraint does not admit would fail at the moment it recorded
  -- what it did — the exact defect that migration exists to close.
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'order_submission_activity'
      and c.conname = 'order_submission_activity_action_check'
      and position('''workbook_replaced_by_admin''' in pg_get_constraintdef(c.oid)) > 0
  ) then
    raise exception
      'the activity action set does not admit workbook_replaced_by_admin — 20261001000000 must be applied first';
  end if;

  raise notice '20261003000000 applied: Change PI authority, and what a replacement means after submission.';
end $$;
